// Loads dist/firefox (a --dev build) into Firefox as a temporary add-on (WebDriver BiDi) and checks what the Chromium
// smoke test checks, where the Broker and the Engine share the event page:
//   1. the panel reaches the Engine over a Port; 2. page tools act on a tab; 3. a prompt's run (the demo model reading
//   the tab) streams into the panel.
// The steps run inside the extension (src/panel/selftest.ts) and are reported here.
// OSHAWATT_FIREFOX names the browser; by default the installed Firefox.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { root, testSite } from "./lib/smoke.mjs";

const extension = join(root, "dist", "firefox");
const executablePath = process.env.OSHAWATT_FIREFOX ?? "C:/Program Files/Mozilla Firefox/firefox.exe";

let reported;
const report = new Promise((resolve) => (reported = resolve));
const site = await testSite({
	routes: {
		"POST /report": (req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk)).on("end", () => {
				res.writeHead(204, { "access-control-allow-origin": "*" }).end();
				reported(JSON.parse(body));
			});
		},
	},
});

const steps = [];
const step = (name, ok, detail = "") => {
	steps.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await puppeteer.launch({ browser: "firefox", executablePath, headless: true });
try {
	// The extension drives itself: installed next to this tab, a dev build opens its panel in self-test mode, which
	// runs the steps and posts them to /report (WebDriver BiDi cannot reach extension pages in Firefox).
	const page = await browser.newPage();
	await page.goto(`${site.url}?oshawatt-selftest`);
	await browser.installExtension(extension);
	const results = await Promise.race([
		report,
		new Promise((_, reject) => setTimeout(() => reject(new Error("no self-test report within 60 s")), 60_000)),
	]);
	for (const { name, ok, detail } of results.steps) step(name, ok, detail);
	if (results.screenshot) {
		await writeFile(join(root, "dist", "smoke-firefox-panel.png"), Buffer.from(results.screenshot.split(",")[1], "base64"));
		console.log("  panel screenshot: dist/smoke-firefox-panel.png");
	}
} finally {
	await browser.close();
	site.close();
}
const failed = steps.filter((s) => !s.ok);
if (failed.length) {
	console.error(`${failed.length} step(s) failed`);
	process.exit(1);
}
