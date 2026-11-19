import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type Tab } from "../src/contracts/browser.ts";
import { Approvals, DECLINED } from "../src/engine/approvals.ts";
import { until } from "./support/wait.ts";
import { connectPanel, context, fakeBrowser, linkTo, openEngine, serveBrowser, servePage, useModel } from "./support/world.ts";

type ToolResult = { role: "toolResult"; toolName: string; isError: boolean; details?: unknown; content: { type: string; text?: string }[] };

/** An Engine with a scripted model, a browser of `tabs` (the first is active) and one page that counts its clicks. */
async function fixture(tabs: Tab[]) {
	const opened: string[] = [];
	const clicks: number[] = [];
	const broker = await serveBrowser(fakeBrowser({
		listTabs: async () => tabs,
		activeTab: async () => tabs[0] ?? null,
		getTab: async ({ tabId }) => tabs.find((tab) => tab.tabId === tabId) ?? null,
		openTab: async ({ url }) => {
			opened.push(url);
			return { tabId: 50, windowId: 1, url, title: "Opened", active: true };
		},
	}));
	const done = async () => ({ ok: true });
	const page = (tabId: number) => servePage(tabId, {
		page_snapshot: async () => ({ url: "https://example.com/", title: "Example", text: "", truncated: false, elements: [] }),
		page_inspect: async () => ({ url: "https://example.com/", matched: 0, truncated: false, elements: [] }),
		page_click: async () => {
			clicks.push(tabId);
			return { ok: true };
		},
		page_type: done, page_select: done, page_press: done, page_hover: done, page_scroll: done, page_wait: done,
		describe: async () => ({ role: "button", name: "Buy now" }),
	});
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const engine = await openEngine(broker, { models, tab: async (tabId) => linkTo(await page(tabId)) });
	const panel = await connectPanel(engine);
	const { workspace } = panel;
	await useModel(workspace, faux);
	const chat = await panel.chat(await workspace.createChat({}, context));
	let request = 0;
	/** Sends a prompt the model answers with one tool call, and returns that call's result once the run has ended. */
	const call = async (tool: string, args: Record<string, unknown>, tabId?: number, during?: () => Promise<void>) => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall(tool, args as never), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
		const before = chat.view.value?.entries.length ?? 0;
		await chat.send({ text: "go", requestId: `r${++request}`, ...(tabId === undefined ? {} : { tabId }) }, context);
		await during?.();
		await until(() => {
			const entries = chat.view.value?.entries ?? [];
			const last = entries.at(-1)?.model?.[0] as { role?: string; stopReason?: string } | undefined;
			return entries.length > before && last?.role === "assistant" && last.stopReason === "stop" ? true : undefined;
		}, `the run after ${tool}`);
		const results = (chat.view.value?.entries ?? []).filter((entry) => entry.kind === "pi.tool-result");
		return results.at(-1)!.model![0] as unknown as ToolResult;
	};
	return {
		workspace, chat, call, clicks, opened,
		close: async () => {
			await panel.close();
			await engine.close();
			await broker.close(context);
		},
	};
}

const tab = (tabId: number, host: string): Tab => ({ tabId, windowId: 1, url: `https://${host}/`, title: host, active: tabId === 7 });

test("non-http(s) tabs refuse page tools", async () => {
	const f = await fixture([{ tabId: 7, windowId: 1, url: "chrome://settings/", title: "Settings", active: true }]);
	try {
		const result = await f.call("page_click", { ref: "e1" }, 7);
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /only on http and https pages/);
		assert.deepEqual(f.clicks, []);
	} finally {
		await f.close();
	}
});

test("a closed target tab falls back to the active tab, and a named tab that is gone is an error", async () => {
	const f = await fixture([tab(7, "example.com")]);
	try {
		// The chat's target is tab 99, which no longer exists.
		assert.equal((await f.call("page_click", { ref: "e1" }, 99)).isError, false);
		assert.deepEqual(f.clicks, [7]);
		const named = await f.call("page_click", { ref: "e1", tabId: 99 });
		assert.equal(named.isError, true);
		assert.match(JSON.stringify(named.content), /No tab 99/);
	} finally {
		await f.close();
	}
});

test("with confirmation on, unsafe page actions wait for allow/deny and refusals reach the model", async () => {
	const f = await fixture([tab(7, "example.com")]);
	try {
		await f.workspace.setPreference({ key: "confirmActions", enabled: true }, context);
		await until(() => f.workspace.confirmActions.value || undefined, "the preference");
		const answer = (decision: "allow" | "deny", expectedClicks: number[]) => async () => {
			const [asked] = await until(() => f.chat.approvals.value.length ? f.chat.approvals.value : undefined, "the approval request");
			assert.deepEqual({ ...asked, id: "" }, { id: "", tool: "page_click", target: "Buy now (button)", site: "example.com" });
			assert.deepEqual(f.clicks, expectedClicks, "nothing is clicked while the request waits");
			await f.chat.decide({ id: asked!.id, decision }, context);
		};
		const denied = await f.call("page_click", { ref: "e1" }, 7, answer("deny", []));
		assert.equal(denied.isError, true);
		assert.ok(JSON.stringify(denied.content).includes(DECLINED));
		assert.deepEqual(f.clicks, []);
		const allowed = await f.call("page_click", { ref: "e1" }, 7, answer("allow", []));
		assert.equal(allowed.isError, false);
		assert.deepEqual(f.clicks, [7]);
		assert.deepEqual(allowed.details, { element: { role: "button", name: "Buy now" } });
		// A second action still asks: there is no per-chat sticky trust.
		assert.equal((await f.call("page_click", { ref: "e1" }, 7, answer("allow", [7]))).isError, false);
		assert.deepEqual(f.clicks, [7, 7]);
		// Reading a page never asks.
		assert.equal((await f.call("page_snapshot", {}, 7)).isError, false);
	} finally {
		await f.close();
	}
});

test("tab_open opens http(s) URLs directly when confirmation is off and asks only when confirmation is on", async () => {
	const f = await fixture([tab(7, "example.com")]);
	try {
		assert.equal((await f.call("tab_open", { url: "https://elsewhere.example/next" }, 7)).isError, false);
		const scheme = await f.call("tab_open", { url: "javascript:alert(1)" }, 7);
		assert.match(JSON.stringify(scheme.content), /Only http and https/);
		await f.workspace.setPreference({ key: "confirmActions", enabled: true }, context);
		await until(() => f.workspace.confirmActions.value || undefined, "the preference");
		const refused = await f.call("tab_open", { url: "https://blocked.example/?q=secret" }, 7, async () => {
			const [asked] = await until(() => f.chat.approvals.value.length ? f.chat.approvals.value : undefined, "the approval request");
			assert.equal(asked!.target, "https://blocked.example/?q=secret");
			await f.chat.decide({ id: asked!.id, decision: "deny" }, context);
		});
		assert.equal(refused.isError, true);
		assert.deepEqual(f.opened, ["https://elsewhere.example/next"]);
	} finally {
		await f.close();
	}
});

test("approvals settle each decision individually and decline waiting items on forget, abort, and close", async () => {
	const approvals = new Approvals();
	const request = (chat: number) => approvals.request({ chat, tool: "page_click", target: "x", site: "example.com" });
	const settled = (promise: Promise<void>) => promise.then(() => "allowed", (error: Error) => error.message);
	const first = settled(request(1));
	const second = settled(request(1));
	const other = settled(request(2));
	const { value } = await approvals.observe({ advance: () => {}, end: () => {} });
	assert.equal(value.items.length, 3);
	assert.equal(approvals.decide(value.items[0]!.id, "allow"), true);
	assert.equal(await first, "allowed");
	approvals.forget(2);
	assert.equal(await other, DECLINED);
	const aborted = new AbortController();
	const stopped = settled(approvals.request({ chat: 3, tool: "page_click", target: "x", site: "example.com" }, aborted.signal));
	aborted.abort(new Error("stopped"));
	assert.equal(await stopped, "stopped");
	approvals.close();
	assert.equal(await second, DECLINED);
	assert.equal(approvals.decide("gone", "allow"), false);
});
