import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchExtension } from "./lib/browsers.mjs";
import { dist } from "./lib/paths.mjs";
import { testSite } from "./lib/site.mjs";
import { until } from "./lib/smoke.mjs";

const out = process.argv[2] ?? dist("screenshots");
const lang = process.env.OSHAWOTT_LANG ?? "zh-CN";
const zh = lang.startsWith("zh");
// Chromium on Linux takes its UI language from LANGUAGE, not --lang. An explicit OSHAWOTT_LANG must win over the shell.
process.env.LANGUAGE = lang.replace("-", "_");
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="${zh ? "zh-CN" : "en"}"><meta charset="utf-8"><title>${zh ? "港湾潮汐 · 本周预报" : "Harbor Tides · This Week"}</title>
<style>body{font:15px/1.6 system-ui;margin:0;color:#1d2733}header{background:#0f4c81;color:#fff;padding:18px 28px}main{padding:20px 28px}
table{border-collapse:collapse}td,th{border:1px solid #d6dde6;padding:4px 10px}form{margin-top:16px;display:flex;gap:8px}</style>
<header><h1>${zh ? "港湾潮汐" : "Harbor Tides"}</h1><nav><a href="#">${zh ? "预报" : "Forecast"}</a> · <a href="#">${zh ? "潮位表" : "Tables"}</a> · <a href="#">${zh ? "订阅" : "Subscribe"}</a></nav></header>
<main><p>${zh ? "本周满潮出现在清晨与傍晚，周四风浪较大，出海请留意预警。" : "High tides come at dawn and dusk this week; Thursday is windy, mind the warnings."}</p>
<table><tr><th>${zh ? "日期" : "Day"}</th><th>${zh ? "满潮" : "High"}</th><th>${zh ? "干潮" : "Low"}</th></tr><tr><td>${zh ? "周一" : "Mon"}</td><td>05:42</td><td>11:58</td></tr><tr><td>${zh ? "周二" : "Tue"}</td><td>06:20</td><td>12:37</td></tr></table>
<form><input placeholder="${zh ? "邮箱地址" : "Email address"}"><button type="button">${zh ? "订阅提醒" : "Get alerts"}</button></form></main></html>`;

const site = await testSite({ page: PAGE });
const { browser, id } = await launchExtension({ args: [`--lang=${lang}`] });
const shots = [];
try {
	const tab = await browser.newPage();
	await tab.goto(site.url);
	const panel = await browser.newPage();
	await panel.setViewport({ width: 400, height: 760, deviceScaleFactor: 2 });
	await panel.goto(`chrome-extension://${id}/panel.html`);
	const shoot = async (name, scheme) => {
		await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
		await new Promise((r) => setTimeout(r, 350));
		const layout = await panel.evaluate(() => ({
			viewport: innerWidth, document: document.documentElement.scrollWidth,
			height: innerHeight, dockBottom: document.querySelector(".composer-wrap").getBoundingClientRect().bottom,
		}));
		if (layout.document > layout.viewport + 1) throw new Error(`${name}: horizontal layout overflow (${layout.document} > ${layout.viewport})`);
		if (layout.dockBottom > layout.height + 1) throw new Error(`${name}: composer dock leaves the viewport (${layout.dockBottom} > ${layout.height})`);
		const path = join(out, `${name}-${scheme}.png`);
		await panel.screenshot({ path });
		shots.push(path);
	};
	const both = async (name) => {
		await shoot(name, "light");
		await shoot(name, "dark");
	};

	await until("the empty state", () => panel.$(".suggestion"));
	const firstSuggestion = zh ? "总结这个页面" : "Summarize this page";
	await until("the requested UI language", () =>
		panel.$eval(".suggestion span:last-child", (n, expected) => (n.textContent === expected ? n.textContent : undefined), firstSuggestion),
	);
	await until("the tab chip", () => panel.$eval("#tab-chip .name", (n) => n.textContent || undefined));
	await both("empty");

	await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
	await panel.type("#prompt", zh ? "这个页面讲了什么？" : "What is this page about?");
	await panel.click("#send");
	await until("the answer streaming", () => panel.$(".msg.assistant[data-live] .md :is(h2, h3) ~ * .caret, .msg.assistant[data-live] .md :is(h2, h3) ~ .caret"), 20_000);
	await panel.screenshot({ path: join(out, "streaming-light.png") });
	shots.push(join(out, "streaming-light.png"));
	await until("the answer", () => panel.$$eval(".msg.assistant .md :is(h2, h3)", (h) => h.length || undefined), 30_000);
	await until("the stream settled", async () => !(await panel.$(".msg.assistant[data-live]")) || undefined);
	await panel.$eval(".thinking", (d) => (d.open = true));
	await panel.$eval("#scroller", (s) => (s.scrollTop = 0));
	await both("chat-top");
	await panel.$eval(".tool", (d) => (d.open = true));
	await both("tool");
	await panel.$eval(".tool", (d) => (d.open = false));
	await panel.$eval("#scroller", (s) => (s.scrollTop = s.scrollHeight));
	await both("chat");

	// Editing a user message replaces its bubble with an inline editor that branches the chat.
	await panel.click(".msg.user [data-action='edit']");
	await until("the inline message editor", () => panel.$(".user-edit-text"));
	await both("edit-message");
	await panel.click(".user-edit-cancel");
	await until("the editor closed", async () => !(await panel.$(".user-edit")) || undefined);

	await panel.click("#model");
	await until("the model menu", () => panel.$("#model-menu .menu-item"));
	for (const [width, height] of [[280, 600], [400, 760], [640, 520]]) {
		await panel.setViewport({ width, height, deviceScaleFactor: 2 });
		await new Promise((resolve) => setTimeout(resolve, 80));
		const layout = await panel.evaluate(() => {
			const menu = document.querySelector("#model-menu").getBoundingClientRect();
			const button = document.querySelector("#model").getBoundingClientRect();
			return { viewport: innerWidth, document: document.documentElement.scrollWidth, menu: { top: menu.top, right: menu.right, bottom: menu.bottom, left: menu.left }, button: { top: button.top, left: button.left } };
		});
		if (layout.document > width + 1 || layout.menu.left < 0 || layout.menu.right > width + 1 || layout.menu.top < 0 || layout.menu.bottom > height + 1) {
			throw new Error(`model popover overflows at ${width}x${height}: ${JSON.stringify(layout)}`);
		}
		// The menu hugs its button instead of clearing the whole dock.
		if (Math.abs(layout.menu.left - layout.button.left) > 1 || Math.abs(layout.button.top - layout.menu.bottom - 8) > 1) {
			throw new Error(`model popover does not hug its button at ${width}x${height}: ${JSON.stringify(layout)}`);
		}
	}
	await panel.setViewport({ width: 400, height: 760, deviceScaleFactor: 2 });
	await both("models");
	await panel.keyboard.press("Escape");
	await panel.click("#thinking");
	await until("the Effort menu", () => panel.$("#thinking-menu .menu-item"));
	await until("the Effort menu anchored to its button", () => panel.evaluate(() => {
		const menu = document.querySelector("#thinking-menu").getBoundingClientRect();
		const button = document.querySelector("#thinking").getBoundingClientRect();
		return Math.abs(menu.right - button.right) <= 1 && Math.abs(button.top - menu.bottom - 8) <= 1 || undefined;
	}));
	await both("thinking");
	await panel.keyboard.press("Escape");

	await panel.click("#chats-toggle");
	await until("the drawer", () => panel.$(".chat-item"));
	await both("chats");
	await panel.click(".chat-item [data-action='more']");
	await until("the chat's actions", () => panel.$(".chat-actions-menu"));
	await both("chats-menu");
	await panel.keyboard.press("Escape");
	await panel.keyboard.press("Escape");
	await new Promise((r) => setTimeout(r, 300));

	await panel.click("#settings-toggle");
	await until("the saved providers", () => panel.$('.provider[data-provider="demo"] .provider-head'));
	await both("settings-top");
	await panel.$eval(".about", (about) => about.scrollIntoView({ block: "end" }));
	await both("settings");
	await panel.click("#add-provider");
	await until("the built-in provider list", () => panel.$("#builtin-provider-list [data-provider]"));
	await both("provider-builtin");
	await panel.click("#builtin-provider-list [data-provider]");
	await until("the chosen provider", () => panel.$("#builtin-provider-chosen:not([hidden])"));
	await both("provider-builtin-chosen");
	await panel.click("#provider-kind-custom");
	for (const width of [280, 400, 640]) {
		await panel.setViewport({ width, height: 760, deviceScaleFactor: 2 });
		const layout = await panel.evaluate(() => ({
			viewport: innerWidth,
			document: document.documentElement.scrollWidth,
			heights: [...document.querySelectorAll(".provider-editor-form .input")].map((input) => input.getBoundingClientRect().height),
		}));
		if (layout.document > layout.viewport + 1 || layout.heights.some((height) => height > 40)) {
			throw new Error(`provider editor is not responsive at ${width}px: ${JSON.stringify(layout)}`);
		}
	}
	await panel.setViewport({ width: 400, height: 760, deviceScaleFactor: 2 });
	await both("provider-custom");
	await panel.click("#provider-back");
	await panel.click("#settings-back");
	await until("the settings closed", async () => !(await panel.$("#settings")) || undefined);
	await panel.click("#new-chat");
	await panel.type("#prompt", zh ? `下载并统计 ${site.url}items.json` : `Download and measure ${site.url}items.json`);
	await panel.click("#send");
	await until("the files processed", () => panel.evaluate(() =>
		document.body.dataset.busy === "false" && document.querySelector('.tool[data-tool="fetch"][data-status="done"]') && document.querySelector('.tool[data-tool="codemode"][data-status="done"]') || undefined,
	), 30_000);
	await both("file-chat");
	await panel.click("#files-toggle");
	await until("the file sheet", () => panel.$$eval(".file-row", (rows) => rows.length === 2 || undefined));
	await panel.click('.file-row[data-path="items.json"] .file-info');
	await until("the JSON preview", () => panel.$('.file-preview[data-status="text"] pre'));
	await both("files");
	await panel.click("#files-back");

	// "Steps" runs four tools in one go (the read fails), so the transcript folds the run.
	await panel.click("#new-chat");
	await panel.type("#prompt", zh ? "步骤" : "steps");
	await panel.click("#send");
	await until("the folded tool run", () => panel.evaluate(() =>
		document.body.dataset.busy === "false" && document.querySelector(".run-fold") || undefined,
	), 30_000);
	await both("run-folded");
	await panel.$eval(".run-fold", (d) => (d.open = true));
	await panel.$eval('.tool[data-tool="page_snapshot"]', (d) => (d.open = true));
	await panel.$eval('.tool[data-tool="codemode"]', (d) => (d.open = true));
	await both("run-expanded");

	// The demo model answers "fail" with a scripted 500, so the shared error notice is real engine output.
	await panel.click("#new-chat");
	await panel.type("#prompt", "fail");
	await until("send enabled", () => panel.$eval("#send", (button) => !button.disabled || undefined));
	await panel.click("#send");
	await until("the retrying error notice", () => panel.$('.notice[data-tone="warn"] .notice-retry'), 30_000);
	await both("error");
	await until("the final model failure notice", () => panel.$('.notice[data-reason="model_error"] #retry'), 60_000);
	await panel.$eval('.notice[data-reason="model_error"] .notice-raw', (details) => { details.open = true; });
	await new Promise((r) => setTimeout(r, 150));
	await both("error-final");
} finally {
	await browser.close();
	site.close();
}
console.log(shots.join("\n"));
