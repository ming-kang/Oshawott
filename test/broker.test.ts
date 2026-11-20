// The real Broker against a fake `browser` API: settle's timing is what a unit test can pin down.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Browser } from "../src/contracts/browser.ts";
import type { Principal } from "../src/contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost, memoryLinkPair, withAbortSignal, type Context } from "../src/lib/chord.ts";

const context = BACKGROUND_CONTEXT;

type ChangeListener = (tabId: number, change: { status?: string }) => void;
interface FakeTab { id: number; windowId: number; status: string; url: string; title: string; active: boolean }

const listeners = new Set<ChangeListener>();
const tabs = new Map<number, FakeTab>();
const permissionListeners = new Set<() => void>();
let siteGranted = true;
let tabGranted = false;
let checkedOrigins: string[][] = [];
let injectionError: string | undefined;
let injections = 0;
const fire = (tabId: number, status: string) => {
	for (const listener of [...listeners]) listener(tabId, { status });
};

(globalThis as { browser?: unknown }).browser = {
	permissions: {
		contains: async ({ origins }: { origins: string[] }) => { checkedOrigins.push(origins); return siteGranted; },
		onAdded: {
			addListener: (listener: () => void) => permissionListeners.add(listener),
			removeListener: (listener: () => void) => permissionListeners.delete(listener),
		},
	},
	scripting: { executeScript: async () => {
		injections++;
		if (injectionError) throw new Error(injectionError);
		if (!siteGranted && !tabGranted) throw new Error("Missing host permission for the tab");
	} },
	tabs: {
		get: async (tabId: number) => {
			const tab = tabs.get(tabId);
			if (!tab) throw new Error(`No tab ${tabId}`);
			return { ...tab };
		},
		onUpdated: {
			addListener: (listener: ChangeListener) => listeners.add(listener),
			removeListener: (listener: ChangeListener) => listeners.delete(listener),
		},
	},
};

// `ext` reads globalThis.browser at module load, so broker.ts must import after the fake is in place.
const brokerModule = import("../src/broker/broker.ts");

const tab = (tabId: number, status = "complete"): FakeTab => ({
	id: tabId, windowId: 1, status, url: "https://example.com/", title: "Example", active: true,
});

async function client() {
	const { startBroker } = await brokerModule;
	const broker = await startBroker(context);
	const host = createHost<Principal>({ onError: () => {} });
	const [engineEnd, brokerEnd] = memoryLinkPair();
	broker.accept(brokerEnd, { principal: { kind: "engine" } }, context);
	host.connect(engineEnd, { principal: { kind: "engine" } }, context);
	await host.load([], context);
	const browser = await host.get(Browser, {}, context);
	return {
		siteAccess: (tabId: number, ctx: Context = context) => browser.siteAccess({ tabId }, ctx),
		attach: (tabId: number) => browser.attach({ tabId }, context),
		settle: (tabId: number) => browser.settle({ tabId }, context),
		close: async () => {
			browser.release();
			await host.close(context);
			await broker.close(context);
		},
	};
}

test("site access checks the tab origin once when granted and skips non-http tabs", async () => {
	const { siteAccess, close } = await client();
	try {
		tabs.set(7, { ...tab(7), url: "https://example.com:8443/notes" });
		checkedOrigins = [];
		const before = injections;
		await siteAccess(7);
		assert.deepEqual(checkedOrigins, [["https://example.com/*"]]);
		assert.equal(injections, before);
		tabs.set(8, { ...tab(8), url: "about:blank" });
		await siteAccess(8);
		assert.equal(checkedOrigins.length, 1);
		assert.equal(permissionListeners.size, 0);
		await assert.rejects(siteAccess(999), /No tab 999/);
		assert.equal(permissionListeners.size, 0);
	} finally { await close(); }
});

test("site access recognizes a temporary tab grant without an origin permission", async () => {
	const { siteAccess, close } = await client();
	try {
		tabs.set(7, tab(7));
		siteGranted = false;
		tabGranted = true;
		injections = 0;
		await siteAccess(7, withAbortSignal(AbortSignal.timeout(1_000), context));
		assert.equal(injections, 1);
		assert.equal(permissionListeners.size, 0);
	} finally { siteGranted = true; tabGranted = false; await close(); }
});

test("site access preserves unrelated probe failures and removes its listener", async () => {
	const { siteAccess, close } = await client();
	try {
		tabs.set(7, tab(7));
		siteGranted = false;
		injectionError = "Tab was closed";
		await assert.rejects(siteAccess(7), /Tab was closed/);
		assert.equal(permissionListeners.size, 0);
	} finally { siteGranted = true; injectionError = undefined; await close(); }
});

test("site access waits for a grant, then continues the same call and removes listeners", async () => {
	const { siteAccess, close } = await client();
	try {
		tabs.set(7, tab(7));
		siteGranted = false;
		let completed = false;
		const pending = siteAccess(7).then(() => { completed = true; });
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(completed, false);
		assert.equal(permissionListeners.size, 1);
		for (const listener of permissionListeners) listener();
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(completed, false);
		siteGranted = true;
		for (const listener of permissionListeners) listener();
		await pending;
		assert.equal(permissionListeners.size, 0);
	} finally { siteGranted = true; await close(); }
});

test("stopping a site access wait rejects and removes its listener", async () => {
	const { siteAccess, close } = await client();
	try {
		tabs.set(7, tab(7));
		siteGranted = false;
		const controller = new AbortController();
		const pending = siteAccess(7, withAbortSignal(controller.signal, context));
		const rejected = assert.rejects(pending);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(permissionListeners.size, 1);
		controller.abort();
		await rejected;
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(permissionListeners.size, 0);
	} finally { siteGranted = true; await close(); }
});

test("settle returns once the load an action started completes, not at the load timeout", async () => {
	const { settle, close } = await client();
	try {
		tabs.set(7, tab(7));
		const at = performance.now();
		const pending = settle(7);
		setTimeout(() => fire(7, "loading"), 50);
		setTimeout(() => {
			tabs.get(7)!.status = "complete";
			fire(7, "complete");
		}, 200);
		assert.equal((await pending).tabId, 7);
		const elapsed = performance.now() - at;
		assert.ok(elapsed < 5_000, `settle on a navigating tab took ${Math.round(elapsed)}ms`);
	} finally {
		await close();
	}
});

test("attach explains revoked site access without hiding unrelated injection failures", async () => {
	const { attach, close } = await client();
	try {
		for (const message of [
			"Missing host permission for the tab",
			'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
		]) {
			injectionError = message;
			await assert.rejects(attach(7), /grant site access in the browser prompt or the browser's extension settings, then retry/);
		}
		injectionError = "Cannot access a chrome:// URL";
		await assert.rejects(attach(7), /Cannot access a chrome:\/\/ URL/);
		injectionError = undefined;
		injections = 0;
		await attach(7);
		assert.equal(injections, 2);
	} finally {
		injectionError = undefined;
		await close();
	}
});

test("settle returns quickly when an action starts no load, and when one is already in flight", async () => {
	const { settle, close } = await client();
	try {
		tabs.set(7, tab(7));
		const quiet = performance.now();
		assert.equal((await settle(7)).tabId, 7);
		const idle = performance.now() - quiet;
		assert.ok(idle < 2_000, `settle on a quiet tab took ${Math.round(idle)}ms`);

		tabs.set(8, tab(8, "loading"));
		const at = performance.now();
		const pending = settle(8);
		setTimeout(() => {
			tabs.get(8)!.status = "complete";
			fire(8, "complete");
		}, 150);
		assert.equal((await pending).tabId, 8);
		const elapsed = performance.now() - at;
		assert.ok(elapsed < 5_000, `settle on a loading tab took ${Math.round(elapsed)}ms`);
	} finally {
		await close();
	}
});
