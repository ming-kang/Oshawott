// Loads dist/chromium (a --dev build) into a real Chromium and checks the topology end to end, through the panel's UI:
//   1. the panel reaches the Engine (the service worker creates the offscreen document; the panel's port lands there);
//   2. page tools act on a tab (the Engine pulls the Broker, which injects the page bundle; the page connects back);
//   3. a prompt runs: the dev build's demo model calls page_snapshot on the tab, and its answer streams into the panel;
//   4. the offscreen document is closed (an eviction): the panel goes on with the next Engine by itself.
import { launchExtension, testSite, until } from "./lib/smoke.mjs";

const steps = [];
const step = (name, ok, detail = "") => {
	steps.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const site = await testSite();
const { browser, worker, id, evaluateIn } = await launchExtension();
try {
	const tab = await browser.newPage();
	await tab.goto(site.url);
	const panel = await browser.newPage();
	await panel.setViewport({ width: 420, height: 820 });
	panel.on("console", (m) => m.type() === "error" && console.log("  [panel]", m.text()));
	panel.on("pageerror", (e) => console.log("  [panel]", e.message));
	await panel.goto(`chrome-extension://${id}/panel.html`);

	// 1. The panel reaches the Engine: the providers in Settings are Engine state.
	await panel.click("#settings-toggle");
	const providers = await until("providers in Settings", () =>
		panel.$$eval(".provider[data-provider]", (rows) => (rows.length ? rows.map((r) => r.dataset.provider) : undefined)),
	);
	await panel.click("#settings-back");
	const offscreen = await browser.waitForTarget((t) => t.url().endsWith("/engine.html"), { timeout: 5_000 });
	step("panel ↔ Engine (offscreen) over a Port", providers.includes("anthropic") && providers.includes("demo"), providers.join(", "));

	// 2. Page tools in the test tab, through the Engine's route to TabHost({ tabId }).
	const chip = await until("the tab chip", () => panel.$eval("#tab-chip .name", (n) => n.textContent || undefined));
	const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0]?.id, site.url);
	const snap = await evaluateIn(offscreen, `oshawatt.page(${tabId}, "page_snapshot", {})`);
	const input = snap.elements.find((e) => e.role.startsWith("input"));
	const button = snap.elements.find((e) => e.name === "Go");
	step("page_snapshot via Broker injection", snap.title === "Oshawatt test page" && input && button, `${snap.elements.length} elements; panel targets “${chip}”`);
	await evaluateIn(offscreen, `oshawatt.page(${tabId}, "page_type", { ref: ${JSON.stringify(input.ref)}, text: "otters" })`);
	await evaluateIn(offscreen, `oshawatt.page(${tabId}, "page_click", { ref: ${JSON.stringify(button.ref)} })`);
	const out = await tab.$eval("#out", (p) => p.textContent);
	step("page_type + page_click act on the page", out === "searched: otters", out);

	// Code mode's QuickJS in its Worker, under the extension CSP (`wasm-unsafe-eval`), with no SharedArrayBuffer.
	const run = await evaluateIn(offscreen, `oshawatt.codemode("text('hi from QuickJS'); return [1, 2, 3].map((n) => n * n)").then((r) => JSON.parse(JSON.stringify(r)))`);
	step("code mode runs in a Worker", run.ok && JSON.stringify(run.value) === "[1,4,9]", `${JSON.stringify(run.value)} ${run.output?.[0]?.text ?? ""}`);

	// 3. A prompt: the demo model reads the tab with page_snapshot and answers in Markdown.
	const ask = async (text) => {
		await panel.type("#prompt", text);
		await panel.click("#send");
	};
	await ask("What is on this page?");
	// The committed answer: a heading, and nothing streaming any more.
	const heading = await until("the answer in the panel", () =>
		panel.evaluate(() =>
			document.querySelector(".msg.assistant[data-live]") ? undefined : [...document.querySelectorAll(".msg.assistant .md :is(h2, h3)")].at(-1)?.textContent || undefined,
		),
	30_000);
	const tool = await panel.$$eval('.tool[data-tool="page_snapshot"]', (cards) => cards.map((c) => [c.dataset.status, c.querySelector(".tool-meta")?.textContent]));
	const title = await panel.$eval("#title", (t) => t.textContent);
	step(
		"prompt → page_snapshot on the tab → answer streamed into the panel",
		heading === "Oshawatt test page" && tool[0]?.[0] === "done" && title === "What is on this page?",
		`tool ${tool[0]?.join(": ")}; title “${title}”`,
	);

	// 4. Eviction: close the offscreen document from the service worker; the panel goes on with the next Engine.
	await evaluateIn(worker, "chrome.offscreen.closeDocument()");
	await until("the old Engine gone", async () => !(await browser.targets()).some((t) => t.url().endsWith("/engine.html")) || undefined, 5_000);
	await until("a new Engine", async () => (await browser.targets()).some((t) => t.url().endsWith("/engine.html")) || undefined);
	await panel.click("#new-chat");
	await ask("And again?");
	await until("the second answer", () => panel.$$eval(".msg.assistant .md :is(h2, h3)", (h) => h.length === 1 || undefined), 20_000);
	await panel.click("#chats-toggle");
	const chats = await until("the chat list", () => panel.$$eval(".chat-item", (items) => (items.length ? items.length : undefined)));
	step("after the offscreen document closed, the panel works on the next Engine", chats === 2, `${chats} chats kept`);
} catch (error) {
	// What the panel showed when a step gave up: dist/smoke-chromium-failure.png and its text.
	const panel = (await browser.pages()).find((p) => p.url().endsWith("/panel.html"));
	if (panel) {
		await panel.screenshot({ path: "dist/smoke-chromium-failure.png" }).catch(() => {});
		console.error("  [panel text]", await panel.evaluate(() => document.body.innerText).catch(() => ""));
	}
	throw error;
} finally {
	await browser.close();
	site.close();
}
const failed = steps.filter((s) => !s.ok);
if (failed.length) {
	console.error(`${failed.length} step(s) failed`);
	process.exit(1);
}
