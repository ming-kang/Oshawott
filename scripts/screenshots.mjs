// Screenshots of the panel in its states, light and dark, from a --dev build (the demo model answers):
//   node scripts/build.mjs chromium --dev && node scripts/screenshots.mjs [outDir]
// outDir defaults to dist/screenshots. OSHAWOTT_LANG sets the UI language (default zh-CN).
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchExtension, root, testSite, until } from "./lib/smoke.mjs";

const out = process.argv[2] ?? join(root, "dist", "screenshots");
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
		const width = await panel.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
		if (width.document > width.viewport + 1) throw new Error(`${name}: horizontal layout overflow (${width.document} > ${width.viewport})`);
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

	// Mid-stream: the answer is still coming in.
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
	// A tool call expanded: its arguments and result.
	await panel.$eval(".tool", (d) => (d.open = true));
	await both("tool");
	await panel.$eval(".tool", (d) => (d.open = false));
	await panel.$eval("#scroller", (s) => (s.scrollTop = s.scrollHeight));
	await both("chat");

	await panel.click("#model");
	await until("the model menu", () => panel.$("#model-menu .menu-item"));
	await both("models");
	await panel.keyboard.press("Escape");

	await panel.click("#chats-toggle");
	await until("the drawer", () => panel.$(".chat-item"));
	await both("chats");
	await panel.keyboard.press("Escape");
	await new Promise((r) => setTimeout(r, 300));

	await panel.click("#settings-toggle");
	await until("the providers", () => panel.$('.provider[data-provider="anthropic"] .provider-head'));
	await panel.click('.provider[data-provider="anthropic"] .provider-head');
	await both("settings");
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
	await both("files");
} finally {
	await browser.close();
	site.close();
}
console.log(shots.join("\n"));
