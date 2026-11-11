import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { NO_ACCESS_CODE, type Tab } from "../src/contracts/browser.ts";
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
			return { tabId: 50, windowId: 1, url, title: "Opened", active: true, access: false };
		},
		hasAccess: async ({ url }) => tabs.some((tab) => tab.access && new URL(tab.url).host === new URL(url).host),
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

const tab = (tabId: number, host: string, access: boolean): Tab => ({ tabId, windowId: 1, url: `https://${host}/`, title: host, active: tabId === 7, access });

test("a site the user has not allowed refuses page tools with the offer to allow it", async () => {
	const f = await fixture([tab(7, "private.example", false)]);
	try {
		const result = await f.call("page_click", { ref: "e1" }, 7);
		assert.equal(result.isError, true);
		assert.deepEqual(result.details, { access: { url: "https://private.example/" } });
		assert.match(JSON.stringify(result.content), /No access to private\.example/);
		assert.deepEqual(f.clicks, []);
		const entry = f.chat.view.value!.entries.findLast((entry) => entry.kind === "pi.tool-result") as { data?: { diagnostics?: { code?: string }[] } };
		assert.equal(entry.data?.diagnostics?.[0]?.code, NO_ACCESS_CODE);
	} finally {
		await f.close();
	}
});

test("a closed target tab falls back to the active tab, and a named tab that is gone is an error", async () => {
	const f = await fixture([tab(7, "example.com", true)]);
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

test("with confirmation on, a page action waits for the user and a refusal reaches the model", async () => {
	const f = await fixture([tab(7, "example.com", true)]);
	try {
		await f.workspace.setPreference({ key: "confirmActions", enabled: true }, context);
		await until(() => f.workspace.confirmActions.value || undefined, "the preference");
		const answer = (decision: "allow" | "deny" | "allow_chat") => async () => {
			const [asked] = await until(() => f.chat.approvals.value.length ? f.chat.approvals.value : undefined, "the approval request");
			assert.deepEqual({ ...asked, id: "" }, { id: "", tool: "page_click", target: "Buy now (button)", site: "example.com" });
			assert.deepEqual(f.clicks, [], "nothing is clicked while the request waits");
			await f.chat.decide({ id: asked!.id, decision }, context);
		};
		const denied = await f.call("page_click", { ref: "e1" }, 7, answer("deny"));
		assert.equal(denied.isError, true);
		assert.ok(JSON.stringify(denied.content).includes(DECLINED));
		assert.deepEqual(f.clicks, []);
		assert.equal((await f.call("page_click", { ref: "e1" }, 7, answer("allow_chat"))).isError, false);
		assert.deepEqual(f.clicks, [7]);
		// Trusted for the rest of the chat: the next action does not ask.
		assert.equal((await f.call("page_click", { ref: "e1" }, 7)).isError, false);
		assert.deepEqual(f.clicks, [7, 7]);
		// Reading a page never asks.
		assert.equal((await f.call("page_snapshot", {}, 7)).isError, false);
	} finally {
		await f.close();
	}
});

test("opening a site the user has not allowed always asks, and only http(s) URLs open", async () => {
	const f = await fixture([tab(7, "example.com", true)]);
	try {
		assert.equal((await f.call("tab_open", { url: "https://example.com/next" }, 7)).isError, false, "an allowed site opens without asking");
		const refused = await f.call("tab_open", { url: "https://elsewhere.example/?q=secret" }, 7, async () => {
			const [asked] = await until(() => f.chat.approvals.value.length ? f.chat.approvals.value : undefined, "the approval request");
			assert.equal(asked!.target, "https://elsewhere.example/?q=secret");
			await f.chat.decide({ id: asked!.id, decision: "deny" }, context);
		});
		assert.equal(refused.isError, true);
		const scheme = await f.call("tab_open", { url: "javascript:alert(1)" }, 7);
		assert.match(JSON.stringify(scheme.content), /Only http and https/);
		assert.deepEqual(f.opened, ["https://example.com/next"]);
	} finally {
		await f.close();
	}
});

test("approvals: trusting a chat answers all it waits for, and forgetting it declines them", async () => {
	const approvals = new Approvals();
	const request = (chat: number) => approvals.request({ chat, tool: "page_click", target: "x", site: "example.com" });
	const settled = (promise: Promise<void>) => promise.then(() => "allowed", (error: Error) => error.message);
	const first = settled(request(1));
	const second = settled(request(1));
	const other = settled(request(2));
	const { value } = await approvals.observe({ advance: () => {}, end: () => {} });
	assert.equal(value.items.length, 3);
	assert.equal(approvals.decide(value.items[0]!.id, "allow_chat"), true);
	assert.deepEqual(await Promise.all([first, second]), ["allowed", "allowed"]);
	assert.equal(await settled(request(1)), "allowed", "a trusted chat is not asked again");
	approvals.forget(2);
	assert.equal(await other, DECLINED);
	approvals.forget(1);
	const again = settled(request(1));
	const aborted = new AbortController();
	const stopped = settled(approvals.request({ chat: 3, tool: "page_click", target: "x", site: "example.com" }, aborted.signal));
	aborted.abort(new Error("stopped"));
	assert.equal(await stopped, "stopped");
	approvals.close();
	assert.equal(await again, DECLINED);
	assert.equal(approvals.decide("gone", "allow"), false);
});
