import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchExtension, modelApi, root, TEST_DOWNLOAD, TEST_LARGE_DOWNLOAD, testSite, until } from "./lib/smoke.mjs";

const steps = [];
const step = (name, ok, detail = "") => {
	steps.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const downloads = join(root, "dist", "smoke-downloads");
await rm(downloads, { recursive: true, force: true });
await mkdir(downloads, { recursive: true });
const models = modelApi();
const site = await testSite({ routes: models.routes });
const { browser, worker, id, evaluateIn } = await launchExtension();
let downloadSession;
try {
	// Chromium resets a CDP client's download policy when it detaches; keep this session until the test ends.
	downloadSession = await browser.target().createCDPSession();
	await downloadSession.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
	const tab = await browser.newPage();
	await tab.goto(site.url);
	const panel = await browser.newPage();
	await panel.setViewport({ width: 420, height: 820 });
	panel.on("console", (m) => m.type() === "error" && console.log("  [panel]", m.text()));
	panel.on("pageerror", (e) => console.log("  [panel]", e.message));
	await panel.goto(`chrome-extension://${id}/panel.html`);

	await panel.click("#settings-toggle");
	const providers = await until("providers in Settings", () =>
		panel.$$eval(".provider[data-provider]", (rows) => (rows.length ? rows.map((r) => r.dataset.provider) : undefined)),
	);
	await panel.click("#settings-back");
	const offscreen = await browser.waitForTarget((t) => t.url().endsWith("/engine.html"), { timeout: 5_000 });
	step("panel ↔ Engine (offscreen) over a Port", providers.includes("demo") && !providers.includes("anthropic"), providers.join(", "));

	const chip = await until("the tab chip", () => panel.$eval("#tab-chip .name", (n) => n.textContent || undefined));
	const tabId = await panel.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}*` }))[0]?.id, site.url);
	const snap = await evaluateIn(offscreen, `oshawott.page(${tabId}, "page_snapshot", {})`);
	const input = snap.elements.find((e) => e.role.startsWith("input"));
	const button = snap.elements.find((e) => e.name === "Go");
	step("page_snapshot via Broker injection", snap.title === "Oshawott test page" && input && button, `${snap.elements.length} elements; panel targets “${chip}”`);
	await evaluateIn(offscreen, `oshawott.page(${tabId}, "page_type", { ref: ${JSON.stringify(input.ref)}, text: "otters" })`);
	await evaluateIn(offscreen, `oshawott.page(${tabId}, "page_click", { ref: ${JSON.stringify(button.ref)} })`);
	const out = await tab.$eval("#out", (p) => p.textContent);
	step("page_type + page_click act on the page", out === "searched: otters", out);

	await panel.exposeFunction("__oshawottPageTool", (target, tool, args) =>
		evaluateIn(offscreen, `oshawott.page(${target}, ${JSON.stringify(tool)}, ${JSON.stringify(args)})`));
	for (const { name, ok, detail } of await panel.evaluate((origin) =>
		globalThis.__oshawottTest.pageTools(origin, globalThis.__oshawottPageTool), site.url)) step(name, ok, detail);

	const run = await evaluateIn(offscreen, `oshawott.codemode("text('hi from QuickJS'); return [1, 2, 3].map((n) => n * n)").then((r) => JSON.parse(JSON.stringify(r)))`);
	step("code mode runs in a Worker", run.ok && JSON.stringify(run.value) === "[1,4,9]", `${JSON.stringify(run.value)} ${run.output?.[0]?.text ?? ""}`);

	const ask = async (text) => {
		await panel.type("#prompt", text);
		await panel.click("#send");
	};
	await ask("What is on this page?");
	const heading = await until("the answer in the panel", () =>
		panel.evaluate(() =>
			document.querySelector(".msg.assistant[data-live]") ? undefined : [...document.querySelectorAll(".msg.assistant .md :is(h2, h3)")].at(-1)?.textContent || undefined,
		),
	30_000);
	const tool = await panel.$$eval('.tool[data-tool="page_snapshot"]', (cards) => cards.map((c) => [c.dataset.status, c.querySelector(".tool-meta")?.textContent]));
	const title = await panel.$eval("#title", (t) => t.textContent);
	step(
		"prompt → page_snapshot on the tab → answer streamed into the panel",
		heading === "Oshawott test page" && tool[0]?.[0] === "done" && title === "What is on this page?",
		`tool ${tool[0]?.join(": ")}; title “${title}”`,
	);

	await ask(`Download and measure ${site.url}items.json`);
	await panel.click("#files-toggle");
	await until("fetch and Code Mode finished", () => panel.evaluate(() => {
		const fetch = document.querySelector('.tool[data-tool="fetch"]');
		const code = document.querySelector('.tool[data-tool="codemode"]');
		return document.body.dataset.busy === "false" && fetch?.dataset.status === "done" && code?.dataset.status === "done" || undefined;
	}), 30_000);
	const files = await until("the file sheet refreshed after the run", () => panel.$$eval(".file-row", (rows) => rows.length === 2 ? rows.map((r) => r.dataset.path) : undefined));
	step("fetch → Code Mode file read/write → file sheet refresh", files.includes("items.json") && files.includes("items.json.stats.json"), files.join(", "));

	await panel.click('.file-row[data-path="items.json"] .file-download');
	const downloaded = await until("a real browser download", () => readFile(join(downloads, "items.json"), "utf8"));
	step("download through Chat.readFile and a Blob URL", downloaded === TEST_DOWNLOAD, `${Buffer.byteLength(downloaded)} UTF-8 bytes`);
	await panel.screenshot({ path: "dist/smoke-chromium-files.png" });
	await panel.click("#files-back");

	await evaluateIn(worker, "chrome.offscreen.closeDocument()");
	await until("the old Engine gone", async () => !(await browser.targets()).some((t) => t.url().endsWith("/engine.html")) || undefined, 5_000);
	await until("a new Engine", async () => (await browser.targets()).some((t) => t.url().endsWith("/engine.html")) || undefined);
	await panel.click("#files-toggle");
	await until("files on the new Engine", () => panel.$$eval(".file-row", (rows) => rows.length === 2 || undefined));
	await panel.click('.file-row[data-path="items.json.stats.json"] .file-download');
	const stats = JSON.parse(await until("the Code Mode file after eviction", () => readFile(join(downloads, "items.json.stats.json"), "utf8")));
	step("files survive Engine eviction, including Code Mode writes", stats.characters === TEST_DOWNLOAD.length && stats.path === "/workspace/items.json", JSON.stringify(stats));

	const remove = '.file-row[data-path="items.json.stats.json"] .file-remove';
	await panel.click(remove);
	await panel.click(remove);
	const remaining = await until("the file removed", () => panel.$$eval(".file-row", (rows) => rows.length === 1 ? rows[0]?.dataset.path : undefined));
	step("file removal refreshes the sheet", remaining === "items.json", remaining);
	await panel.click("#files-back");
	await until("the file sheet closed", async () => !(await panel.$("#files")) || undefined);
	for (const { name, ok, detail } of await panel.evaluate(() => globalThis.__oshawottTest.attachments())) step(name, ok, detail);
	await panel.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(["reload me"], "reload.txt", { type: "text/plain" }));
		const input = document.querySelector("#attachment-input");
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await panel.type("#prompt", "Reload draft");
	await new Promise((resolve) => setTimeout(resolve, 400));
	await panel.reload();
	const restored = await until("draft and history after a Panel reload", () => panel.evaluate(() => {
		const prompt = document.querySelector("#prompt");
		const attachment = document.querySelector("#attachment-tray .attachment-name")?.textContent;
		return prompt?.value === "Reload draft" && attachment === "reload.txt" && document.querySelectorAll(".msg.user .user-attachment").length === 3 || undefined;
	}));
	step("Panel reload restores per-chat drafts and attachment history", Boolean(restored));
	await panel.evaluate(() => {
		const prompt = document.querySelector("#prompt");
		prompt.value = "";
		prompt.dispatchEvent(new Event("input", { bubbles: true }));
		document.querySelector("#attachment-tray .attachment-remove")?.click();
	});
	await new Promise((resolve) => setTimeout(resolve, 250));
	for (const { name, ok, detail } of await panel.evaluate(() => globalThis.__oshawottTest.toolCards())) step(name, ok, detail);
	for (const { name, ok, detail } of await panel.evaluate((origin) => globalThis.__oshawottTest.panel(origin), site.url)) step(name, ok, detail);
	step("local model API receives an actual high-thinking chat request", models.requests.some((request) => request.model === "local-reasoning" && request.reasoning_effort === "high"), `${models.requests.length} request(s)`);
	await panel.click("#new-chat");
	await until("the new chat ready", () => panel.$eval("#files-toggle", (button) => button.hidden || undefined));
	await ask("And again?");
	await until("the second answer", () => panel.$$eval(".msg.assistant .md :is(h2, h3)", (h) => h.length === 1 || undefined), 20_000);
	await panel.click("#files-toggle");
	const empty = await until("the new chat has no files", () => panel.$("#files .files-empty"));
	step("new chats have independent file trees", Boolean(empty));
	await panel.click("#files-back");
	await panel.click("#chats-toggle");
	const chats = await until("the chat list", () => panel.$$eval(".chat-item", (items) => (items.length ? items.length : undefined)));
	step("after the offscreen document closed, the panel works on the next Engine", chats === 3, `${chats} chats kept`);
	await panel.keyboard.press("Escape");

	const fresh = async (text) => {
		await panel.click("#new-chat");
		await until("a fresh chat", () => panel.$eval("#files-toggle", (button) => button.hidden || undefined));
		await ask(text);
		await until("the fresh chat opened", () => panel.$("#files-toggle:not([hidden]):not([disabled])"));
	};
	await fresh(`Download ${site.url}large.json`);
	await panel.click("#files-toggle");
	await until("large text processed in Code Mode", () => panel.evaluate(() =>
		document.body.dataset.busy === "false" && document.querySelector('.tool[data-tool="codemode"][data-status="done"]') && document.querySelector('.file-row[data-path="large.json.stats.json"]') || undefined,
	), 30_000);
	await panel.click('.file-row[data-path="large.json"] .file-download');
	const large = await until("the large file downloaded", () => readFile(join(downloads, "large.json"), "utf8"));
	await panel.click('.file-row[data-path="large.json.stats.json"] .file-download');
	const measured = JSON.parse(await until("the large file statistics", () => readFile(join(downloads, "large.json.stats.json"), "utf8")));
	step("Code Mode reads a >1M-character single line in chunks, without the preview limit", large === TEST_LARGE_DOWNLOAD && measured.characters === TEST_LARGE_DOWNLOAD.length && measured.firstLine.length <= 160, `${measured.characters} characters`);
	await panel.click("#files-back");
	await until("large file sheet closed", async () => !(await panel.$("#files")) || undefined);
	const layouts = [];
	for (const width of [280, 420]) {
		await panel.setViewport({ width, height: 820 });
		layouts.push(await panel.evaluate(() => ({
			viewport: innerWidth, document: document.documentElement.scrollWidth,
			files: document.querySelector("#files-toggle").getBoundingClientRect().right,
		})));
	}
	step("long URLs and JSON do not push controls outside a narrow panel", layouts.every((size) => size.document <= size.viewport + 1 && size.files <= size.viewport + 1), JSON.stringify(layouts));

	for (const [method, path] of [["GET", "redirect-302"], ["POST", "redirect-307"]]) {
		await fresh(`${method === "POST" ? "POST" : "Download"} ${site.url}${path}`);
		const error = await until(`${method} redirect refused`, () => panel.evaluate(() =>
			document.body.dataset.busy === "false" && document.querySelector('.tool[data-tool="fetch"][data-status="error"] .tool-body')?.textContent || undefined,
		), 20_000);
		await panel.click("#files-toggle");
		const empty = await until("no file from the redirect", () => panel.$("#files .files-empty"));
		step(`${method} ${path} refused without saving`, error.includes("Redirects are not followed") && Boolean(empty));
		await panel.click("#files-back");
		await until("redirect file sheet closed", async () => !(await panel.$("#files")) || undefined);
	}
	const redirects = site.redirectHits();
	step("redirect destinations receive no request", redirects.get302 === 1 && redirects.post307 === 1 && redirects.target === 0, JSON.stringify(redirects));

	const initialLanguage = await panel.evaluate(() => document.documentElement.lang);
	const initialPreference = await panel.evaluate(() => localStorage.getItem("oshawott:language") ?? "system");
	const nextLanguage = initialLanguage === "en" ? "zh-CN" : "en";
	const settingsTitle = (language) => language === "en" ? "Settings" : "设置";
	const languageState = (language, preference) => panel.evaluate((expected, expectedPreference, title) => {
		const stored = localStorage.getItem("oshawott:language");
		const preferenceApplied = expectedPreference === "system" ? stored === null : stored === expectedPreference;
		const applied = document.documentElement.lang === expected && preferenceApplied
			&& document.querySelector("#settings-toggle")?.getAttribute("aria-label") === title;
		return applied ? expected : undefined;
	}, language, preference, settingsTitle(language));
	await panel.click("#settings-toggle");
	await Promise.all([
		panel.waitForNavigation({ waitUntil: "domcontentloaded" }),
		panel.click(`#settings-language [data-value="${nextLanguage}"]`),
	]);
	const switched = await until("the new language after a panel reload", () => languageState(nextLanguage, nextLanguage));
	await panel.click("#settings-toggle");
	await until("the language control after a panel reload", () => panel.$(`#settings-language [data-value="${initialPreference}"]`));
	await Promise.all([
		panel.waitForNavigation({ waitUntil: "domcontentloaded" }),
		panel.click(`#settings-language [data-value="${initialPreference}"]`),
	]);
	const languageRestored = await until("the restored language preference after a second panel reload", () => languageState(initialLanguage, initialPreference));
	step("system and explicit language selections persist and apply across panel reloads", switched === nextLanguage && languageRestored === initialLanguage,
		`${initialPreference} → ${nextLanguage} → ${initialPreference}`);
} catch (error) {
	const panel = (await browser.pages()).find((p) => p.url().endsWith("/panel.html"));
	if (panel) {
		await panel.screenshot({ path: "dist/smoke-chromium-failure.png" }).catch(() => {});
		console.error("  [panel text]", await panel.evaluate(() => document.body.innerText).catch(() => ""));
	}
	throw error;
} finally {
	await downloadSession?.detach().catch(() => {});
	await browser.close();
	site.close();
}
const failed = steps.filter((s) => !s.ok);
if (failed.length) {
	console.error(`${failed.length} step(s) failed`);
	process.exit(1);
}
