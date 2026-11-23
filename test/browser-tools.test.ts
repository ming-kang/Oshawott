import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { type Tab } from "../src/contracts/browser.ts";
import { Approvals, DECLINED } from "../src/engine/approvals.ts";
import { ChatFiles, type FileBackend } from "../src/engine/files.ts";
import { readToolDetails } from "../src/tools/details.ts";
import { openFiles } from "./support/files.ts";
import { until } from "./support/wait.ts";
import { type BrowserMembers, connectPanel, context, fakeBrowser, linkTo, openEngine, type PageMembers, serveBrowser, servePage, useModel } from "./support/world.ts";

type ToolResult = { role: "toolResult"; toolName: string; isError: boolean; details?: unknown; content: { type: string; text?: string }[] };

/** An Engine with a scripted model, a browser of `tabs` (the first is active) and one page that counts its clicks. */
async function fixture(tabs: Tab[], options: { browser?: Partial<BrowserMembers>; page?: Partial<PageMembers>; fetch?: typeof fetch; files?: FileBackend } = {}) {
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
		settle: async ({ tabId }) => {
			const found = tabs.find((tab) => tab.tabId === tabId);
			if (!found) throw new Error(`tab ${tabId} gone`);
			return found;
		},
		...options.browser,
	}));
	const done = async () => ({ ok: true });
	const page = (tabId: number) => servePage(tabId, {
		page_snapshot: async () => ({ url: "https://example.com/", title: "Example", text: "", truncated: false, textOffset: 0, totalChars: 0, elements: [], elementsTruncated: false }),
		page_inspect: async () => ({ url: "https://example.com/", matched: 0, truncated: false, elements: [] }),
		page_click: async () => {
			clicks.push(tabId);
			return { ok: true };
		},
		page_type: done, page_select: done, page_press: done, page_hover: done, page_scroll: done, page_wait: done,
		describe: async () => ({ role: "button", name: "Buy now" }),
		settled: async () => ({ url: "https://example.com/", title: "Example", opened: [], appeared: [], appearedMore: false }),
		viewport: async () => ({ width: 1280, height: 800, dpr: 1 }),
		upload: done,
		...options.page,
	});
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const engine = await openEngine(broker, { models, files: options.files, tab: async (tabId) => linkTo(await page(tabId)), ...(options.fetch ? { fetch: options.fetch } : {}) });
	const panel = await connectPanel(engine);
	const { workspace } = panel;
	await useModel(workspace, faux);
	const chatId = await workspace.createChat({}, context);
	const chat = await panel.chat(chatId);
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
	/** Waits for the pending approval and answers it. */
	const decide = async (decision: "allow" | "deny", check?: (asked: { tool: string; target: string; site: string }) => void) => {
		const [asked] = await until(() => chat.approvals.value.length ? chat.approvals.value : undefined, "the approval request");
		check?.(asked!);
		await chat.decide({ id: asked!.id, decision }, context);
	};
	return {
		workspace, chat, chatId, call, clicks, opened, decide,
		close: async () => {
			await panel.close();
			await engine.close();
			await broker.close(context);
		},
	};
}

const tab = (tabId: number, host: string): Tab => ({ tabId, windowId: 1, url: `https://${host}/`, title: host, active: tabId === 7 });

test("a blocked page read waits for site access and resumes the same tool call", async () => {
	let grant!: () => void;
	const permission = new Promise<void>(resolve => { grant = resolve; });
	let waiting = false;
	let reads = 0;
	const f = await fixture([tab(7, "example.com")], {
		browser: { siteAccess: async () => { waiting = true; await permission; return null; } },
		page: { page_snapshot: async () => {
			reads++;
			return { url: "https://example.com/", title: "Example", text: "Granted page", truncated: false, textOffset: 0, totalChars: 12, elements: [], elementsTruncated: false };
		} },
	});
	try {
		const result = await f.call("page_snapshot", {}, 7, async () => {
			await until(() => waiting ? true : undefined, "the site access check");
			assert.equal(reads, 0);
			grant();
		});
		assert.equal(result.isError, false);
		assert.match(JSON.stringify(result.content), /Granted page/);
		assert.equal(reads, 1);
	} finally { grant(); await f.close(); }
});

test("inspect stores bounded previews without further truncating the model output", async () => {
	const elements = Array.from({ length: 20 }, (_, index) => ({
		ref: `e${index + 1}`, tag: "article", visible: true, truncated: true,
		attributes: { "data-large": "x".repeat(500), "data-label": `article-${index}` }, styles: { height: "100px" },
		html: `<article>${index}:${"z".repeat(20_000)}`.slice(0, 20_000),
	}));
	const f = await fixture([tab(7, "example.com")], {
		page: { page_inspect: async () => ({ url: "https://example.com/", matched: 21, truncated: true, elements }) },
	});
	try {
		const result = await f.call("page_inspect", { selector: "article", maxElements: 20, maxHtml: 20_000 }, 7);
		assert.equal(result.isError, false);
		const output = result.content[0]?.text ?? "";
		const serial = JSON.stringify(result.details);
		const bytes = Buffer.byteLength(serial);
		assert.ok(bytes < 12_000, `expected compact details, got ${bytes} bytes`);
		assert.ok(output.includes(elements[0]!.html), "the first raw HTML block is not clipped by the preview limit");
		assert.match(output, /"x{500}"/, "raw output still includes the oversized attribute");
		const details = readToolDetails(result.details, "page_inspect");
		assert.equal(details?.matched, 21);
		assert.equal(details?.elements.length, 20);
		assert.equal(details?.previewTruncated, true);
		const last = details?.elements.at(-1);
		assert.equal(last?.ref, "e20");
		assert.deepEqual(last?.attributes, { "data-label": "article-19" });
		assert.deepEqual(last?.styles, { height: "100px" });
		assert.match(last?.html ?? "", /^<article>19:z+…$/);
	} finally {
		await f.close();
	}
});

test("non-http(s) tabs refuse page tools", async () => {
	const f = await fixture([{ tabId: 7, windowId: 1, url: "chrome://settings/", title: "Settings", active: true }]);
	try {
		const result = await f.call("page_click", { ref: "e1" }, 7);
		assert.equal(result.isError, true);
		assert.match(JSON.stringify(result.content), /only on http, https, and local file pages/);
		assert.deepEqual(f.clicks, []);
	} finally {
		await f.close();
	}
});

test("an already open local file takes page tools but not navigation, and tracks a different file as a new target", async () => {
	const first = `file:///tmp/${encodeURIComponent("笔记 一")}.html`;
	const local = { tabId: 7, windowId: 1, url: first, title: "One", active: true };
	const snapshot = () => ({
		url: local.url, title: local.title, text: `Text of ${local.title}`, truncated: false,
		textOffset: 0, totalChars: 9, elements: [], elementsTruncated: false,
	});
	const f = await fixture([local], {
		page: {
			page_snapshot: async () => snapshot(),
			page_inspect: async () => ({ url: local.url, matched: 0, truncated: false, elements: [] }),
		},
	});
	try {
		const read = await f.call("page_snapshot", {}, 7);
		assert.equal(read.isError, false);
		assert.match(JSON.stringify(read.content), /Text of One/);
		assert.equal((await f.call("page_inspect", { selector: "main" }, 7)).isError, false);
		await f.workspace.setPreference({ key: "confirmActions", enabled: true }, context);
		await until(() => f.workspace.confirmActions.value || undefined, "the preference");
		// A local file has no host: the approval names the file instead.
		const click = await f.call("page_click", { ref: "e1" }, 7, () => f.decide("allow", (asked) => assert.equal(asked.site, "笔记 一.html")));
		assert.equal(click.isError, false);
		assert.deepEqual(f.clicks, [7]);
		const navigation = await f.call("tab_navigate", { url: "file:///tmp/two.html" }, 7);
		assert.equal(navigation.isError, true);
		assert.match(JSON.stringify(navigation.content), /Only http and https/);

		local.url = "file:///tmp/two.html";
		local.title = "Two";
		const moved = await f.call("page_snapshot", {});
		assert.ok(JSON.stringify(moved.content).includes(`the target tab is now on file:///tmp/two.html (it was ${first})`));
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

test("an action reports a navigation it caused and a receipt failure never fails the action", async () => {
	const moved = tab(7, "elsewhere.example");
	// The click navigates: the settle returns the new URL, so the result says where it went.
	const navigating = await fixture([tab(7, "example.com")], { browser: { settle: async () => moved } });
	try {
		const result = await navigating.call("page_click", { ref: "e1" }, 7);
		assert.equal(result.isError, false);
		assert.match(JSON.stringify(result.content), /Navigated to https:\/\/elsewhere\.example\//);
		assert.deepEqual(navigating.clicks, [7]);
	} finally {
		await navigating.close();
	}
	const broken = await fixture([tab(7, "example.com")], {
		browser: { settle: async () => { throw new Error("tab gone mid-navigation"); } },
	});
	try {
		const result = await broken.call("page_click", { ref: "e1" }, 7);
		assert.equal(result.isError, false);
		assert.deepEqual(broken.clicks, [7]);
	} finally {
		await broken.close();
	}
});

test("a receipt names elements that appeared, the target's new state and tabs the action opened", async () => {
	const foreign = tab(7, "example.com");
	const spawned = tab(50, "new.example");
	let showSpawned = false;
	const f = await fixture([foreign], {
		browser: {
			listTabs: async () => (showSpawned ? [foreign, spawned] : [foreign]),
			getTab: async ({ tabId }) => [foreign, spawned].find((each) => each.tabId === tabId) ?? null,
		},
		page: {
			page_click: async () => {
				showSpawned = true;
				return { ok: true };
			},
			settled: async () => ({
				url: "https://example.com/", title: "Example", opened: [],
				appeared: [{ ref: "abcd.e9", role: "menuitem", name: "Item A" }],
				appearedMore: false,
				target: { ref: "abcd.e1", role: "button", name: "Menu", expanded: true },
			}),
		},
	});
	try {
		const result = await f.call("page_click", { ref: "abcd.e1" }, 7);
		assert.equal(result.isError, false);
		const output = result.content.map((part) => part.text ?? "").join("\n");
		assert.match(output, /Now: \[abcd\.e1\] button "Menu" expanded=true/);
		assert.match(output, /Appeared:\n\[abcd\.e9\] menuitem "Item A"/);
		assert.match(output, /Opened tab 50: "new\.example" https:\/\/new\.example\/ — not the target; tab_activate it to work there\./);
		// A tab the action opened is this chat's now: closing it needs no approval while confirmation is off.
		assert.equal((await f.call("tab_close", { tabId: 50 })).isError, false);
		assert.equal(f.chat.approvals.value.length, 0);
	} finally {
		await f.close();
	}
});

test("page_upload sends a chat file's name, type and bytes to the page; a missing path never reaches it", async () => {
	const files = await openFiles();
	const uploads: { ref: string; files: { name: string; type: string; data: Uint8Array }[] }[] = [];
	const f = await fixture([tab(7, "example.com")], {
		files,
		page: { upload: async (args) => { uploads.push(args); return { ok: true }; } },
	});
	try {
		getOrThrow(await new ChatFiles(files, f.chatId).writeFile("docs/a.pdf", new Uint8Array([37, 80, 68, 70]), context));
		const result = await f.call("page_upload", { ref: "e1", paths: ["docs/a.pdf"] }, 7);
		assert.equal(result.isError, false);
		assert.equal(uploads.length, 1);
		assert.equal(uploads[0]!.ref, "e1");
		assert.deepEqual(
			uploads[0]!.files.map(({ name, type, data }) => ({ name, type, data: [...data] })),
			[{ name: "a.pdf", type: "application/pdf", data: [37, 80, 68, 70] }],
		);
		const missing = await f.call("page_upload", { ref: "e1", paths: ["nope.pdf"] }, 7);
		assert.equal(missing.isError, true);
		assert.equal(uploads.length, 1, "the page is never called for a missing file");
	} finally {
		await f.close();
	}
});

test("a user move of the target tab to another origin is noted once; the agent's own moves are silent", async () => {
	const target = tab(7, "example.com");
	const f = await fixture([target], {
		browser: {
			navigateTab: async ({ tabId, url }) => {
				if (url !== undefined) {
					target.url = url;
					target.title = new URL(url).host;
				}
				return { ...target };
			},
		},
	});
	try {
		// First call binds the origin without noting anything.
		assert.equal((await f.call("page_snapshot", {}, 7)).isError, false);
		target.url = "https://other.example/page";
		target.title = "other.example";
		const noted = await f.call("page_snapshot", {});
		assert.match(JSON.stringify(noted.content), /the target tab is now on https:\/\/other\.example \(it was https:\/\/example\.com\)/);
		const again = await f.call("page_snapshot", {});
		assert.doesNotMatch(JSON.stringify(again.content), /the target tab is now on/);
		// The agent's own navigation re-binds the origin: no note afterwards.
		assert.equal((await f.call("tab_navigate", { url: "https://agent.example/" })).isError, false);
		const quiet = await f.call("page_snapshot", {});
		assert.doesNotMatch(JSON.stringify(quiet.content), /the target tab is now on/);
	} finally {
		await f.close();
	}
});

test("navigating a named tab that is not the target leaves the chat's origin binding alone", async () => {
	const target = tab(7, "example.com");
	const other = tab(8, "other.example");
	const f = await fixture([target, other], {
		browser: {
			navigateTab: async ({ tabId, url }) => {
				const moved = [target, other].find((each) => each.tabId === tabId)!;
				if (url !== undefined) {
					moved.url = url;
					moved.title = new URL(url).host;
				}
				return { ...moved };
			},
		},
	});
	try {
		// The target's origin binds silently on first use.
		assert.equal((await f.call("page_snapshot", {}, 7)).isError, false);
		// Writing another tab's origin into the binding would warn falsely on the next target call.
		assert.equal((await f.call("tab_navigate", { tabId: 8, url: "https://elsewhere.example/" })).isError, false);
		const next = await f.call("page_snapshot", {});
		assert.doesNotMatch(JSON.stringify(next.content), /the target tab is now on/);
	} finally {
		await f.close();
	}
});

test("closing a foreign tab always asks; a tab this chat opened follows the confirmation switch", async () => {
	const closed: number[] = [];
	const foreign = tab(7, "example.com");
	const extra: Tab[] = [];
	const f = await fixture([foreign], {
		browser: {
			getTab: async ({ tabId }) => [foreign, ...extra].find((each) => each.tabId === tabId) ?? null,
			openTab: async ({ url }) => {
				const next = { tabId: 50 + extra.length, windowId: 1, url, title: "Opened", active: true };
				extra.push(next);
				return next;
			},
			closeTab: async ({ tabId }) => {
				closed.push(tabId);
				return null;
			},
		},
	});
	try {
		// confirmActions stays off, and still asks: tab 7 is not this chat's.
		await f.call("tab_close", { tabId: 7 }, 7, () => f.decide("allow"));
		assert.deepEqual(closed, [7]);
		// Tab 50 this chat opened (session matches) is closed without asking.
		assert.equal((await f.call("tab_open", { url: "https://new.example/" })).isError, false);
		assert.equal((await f.call("tab_close", { tabId: 50 })).isError, false);
		assert.deepEqual(f.chat.approvals.value.length, 0);
		assert.deepEqual(closed, [7, 50]);
	} finally {
		await f.close();
	}
});

test("a tab opened in an earlier browser session counts as foreign", async () => {
	const closed: number[] = [];
	const foreign = tab(7, "example.com");
	const extra: Tab[] = [];
	const state = { session: "one" };
	const f = await fixture([foreign], {
		browser: {
			getTab: async ({ tabId }) => [foreign, ...extra].find((each) => each.tabId === tabId) ?? null,
			openTab: async ({ url }) => {
				const next = { tabId: 50 + extra.length, windowId: 1, url, title: "Opened", active: true };
				extra.push(next);
				return next;
			},
			closeTab: async ({ tabId }) => {
				closed.push(tabId);
				return null;
			},
			session: async () => state.session,
		},
	});
	try {
		assert.equal((await f.call("tab_open", { url: "https://new.example/" })).isError, false);
		// The browser restarted: the stored session id no longer matches, so the tab is foreign again.
		state.session = "two";
		await f.call("tab_close", { tabId: 50 }, undefined, () => f.decide("allow"));
		assert.deepEqual(closed, [50]);
	} finally {
		await f.close();
	}
});

test("fetch asks before a non-GET request only when confirmation is on", async () => {
	const f = await fixture([tab(7, "example.com")], { fetch: async () => new Response("ok", { status: 200 }) });
	try {
		assert.equal((await f.call("fetch", { url: "https://api.example/data", method: "POST" })).isError, false);
		await f.workspace.setPreference({ key: "confirmActions", enabled: true }, context);
		await until(() => f.workspace.confirmActions.value || undefined, "the preference");
		// GET and HEAD are reads: they never ask for themselves.
		assert.equal((await f.call("fetch", { url: "https://api.example/data" })).isError, false);
		assert.equal((await f.call("fetch", { url: "https://api.example/data", method: "HEAD" })).isError, false);
		await f.call("fetch", { url: "https://api.example/data", method: "POST" }, undefined, () =>
			f.decide("allow", (asked) => {
				assert.equal(asked.tool, "fetch");
				assert.equal(asked.target, "POST https://api.example/data");
				assert.equal(asked.site, "api.example");
			}));
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
