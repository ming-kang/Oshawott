// Loads dist/chromium (a --dev build) into a real Chromium and checks the topology end to end:
//   1. the panel reaches the Engine (the service worker creates the offscreen document; the panel's port lands there);
//   2. a page tool runs in a tab (the Engine pulls the Broker, which injects the page bundle; the page connects back);
//   3. a prompt runs in the Engine and its outcome reaches the panel (no API key: the run ends with a reason);
//   4. the offscreen document is closed (an eviction): the panel reconnects to the next Engine by itself.
// OSHAWATT_CHROME names the browser; by default Playwright's cached Chromium.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const extension = join(root, "dist", "chromium");

function defaultChrome() {
	const cache = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", ".cache"), "ms-playwright");
	const build = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1) : undefined;
	return build && join(cache, build, "chrome-win64", "chrome.exe");
}
const executablePath = process.env.OSHAWATT_CHROME ?? defaultChrome();
if (!executablePath || !existsSync(executablePath)) throw new Error("No Chromium: set OSHAWATT_CHROME");

const PAGE = `<!doctype html><title>Oshawatt test page</title>
<h1>Hello</h1><input id="q" placeholder="Search"><button id="go" onclick="out.textContent='searched: '+q.value">Go</button>
<p id="out">nothing yet</p>`;
const server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}/`;

const steps = [];
const step = (name, ok, detail = "") => {
	steps.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const until = async (what, read, ms = 15_000) => {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
};

const browser = await puppeteer.launch({
	executablePath,
	headless: true,
	enableExtensions: [extension],
	args: ["--no-first-run", "--no-default-browser-check"],
});
try {
	const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
	const id = new URL(worker.url()).host;
	const evaluateIn = async (target, expression) => {
		const session = await target.createCDPSession();
		const { result, exceptionDetails } = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		await session.detach();
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
		return result.value;
	};

	const tab = await browser.newPage();
	await tab.goto(site);
	const panel = await browser.newPage();
	panel.on("console", (m) => m.type() === "error" && console.log("  [panel]", m.text()));
	await panel.goto(`chrome-extension://${id}/panel.html`);

	// 1. The panel reaches the Engine: the provider list is Engine state.
	const providers = await until("providers in the panel", () =>
		panel.$$eval("#provider option", (options) => (options.length ? options.map((o) => o.value) : undefined)),
	);
	const offscreen = await browser.waitForTarget((t) => t.url().endsWith("/engine.html"), { timeout: 5_000 });
	step("panel ↔ Engine (offscreen) over a Port", providers.includes("anthropic"), `providers: ${providers.join(", ")}`);

	// 2. A page tool in the test tab, through the Engine's route to TabHost({ tabId }).
	const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0]?.id, site);
	const snap = await evaluateIn(offscreen, `oshawatt.page(${tabId}, "page_snapshot", {})`);
	const input = snap.elements.find((e) => e.role.startsWith("input"));
	const button = snap.elements.find((e) => e.name === "Go");
	step("page_snapshot via Broker injection", snap.title === "Oshawatt test page" && input && button, `${snap.elements.length} elements`);
	await evaluateIn(offscreen, `oshawatt.page(${tabId}, "page_type", { ref: ${JSON.stringify(input.ref)}, text: "otters" })`);
	await evaluateIn(offscreen, `oshawatt.page(${tabId}, "page_click", { ref: ${JSON.stringify(button.ref)} })`);
	const out = await tab.$eval("#out", (p) => p.textContent);
	step("page_type + page_click act on the page", out === "searched: otters", out);

	// Code mode's QuickJS in its Worker, under the extension CSP (`wasm-unsafe-eval`), with no SharedArrayBuffer.
	const run = await evaluateIn(offscreen, `oshawatt.codemode("text('hi from QuickJS'); return [1, 2, 3].map((n) => n * n)").then((r) => JSON.parse(JSON.stringify(r)))`);
	step("code mode runs in a Worker", run.ok && JSON.stringify(run.value) === "[1,4,9]", `${JSON.stringify(run.value)} ${run.output?.[0]?.text ?? ""}`);

	// 3. A prompt runs in the Engine; without a model or key, the run ends with its reason, shown in the panel.
	await panel.click("#new");
	await until("a chat", () => panel.$$eval("#chats option", (o) => o.length > 0 || undefined));
	await panel.type("#prompt", "What is on this page?");
	await panel.click("#send");
	const note = await until("the run's outcome in the panel", () =>
		panel.$$eval(".msg", (m) => m.map((x) => x.textContent).find((t) => t.startsWith("Run ended"))),
	);
	const user = await panel.$$eval(".msg.user", (m) => m.map((x) => x.textContent));
	step("prompt → Durable run → outcome in the panel", user.includes("What is on this page?"), note);

	// 4. Eviction: close the offscreen document from the service worker; the panel comes back on the next Engine.
	await evaluateIn(worker, "chrome.offscreen.closeDocument()");
	await until("the old Engine gone", async () => !(await browser.targets()).some((t) => t.url().endsWith("/engine.html")) || undefined, 5_000);
	await until("a new Engine", async () => (await browser.targets()).some((t) => t.url().endsWith("/engine.html")) || undefined);
	await panel.click("#new");
	const chats = await until("the second chat", () => panel.$$eval("#chats option", (o) => (o.length >= 2 ? o.length : undefined)));
	step("after the offscreen document closed, the panel works on the next Engine", chats === 2, `${chats} chats kept`);
} finally {
	await browser.close();
	server.close();
}
const failed = steps.filter((s) => !s.ok);
if (failed.length) {
	console.error(`${failed.length} step(s) failed`);
	process.exit(1);
}
