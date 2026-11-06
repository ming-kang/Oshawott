// Loads dist/firefox (a --dev build) into Firefox as a temporary add-on (WebDriver BiDi) and checks what the Chromium
// smoke test checks, where the Broker and the Engine share the event page:
//   1. the panel reaches the Engine over a Port; 2. page tools act on a tab; 3. a prompt's run reaches the panel.
// The steps run inside the extension (src/panel/selftest.ts) and are reported here.
// OSHAWATT_FIREFOX names the browser; by default the installed Firefox.
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const extension = join(root, "dist", "firefox");
const executablePath = process.env.OSHAWATT_FIREFOX ?? "C:/Program Files/Mozilla Firefox/firefox.exe";

const PAGE = `<!doctype html><title>Oshawatt test page</title>
<h1>Hello</h1><input id="q" placeholder="Search"><button id="go" onclick="out.textContent='searched: '+q.value">Go</button>
<p id="out">nothing yet</p>`;
let reported;
const report = new Promise((resolve) => (reported = resolve));
const server = createServer((req, res) => {
	if (req.method === "POST" && req.url === "/report") {
		let body = "";
		req.on("data", (chunk) => (body += chunk)).on("end", () => {
			res.writeHead(204, { "access-control-allow-origin": "*" }).end();
			reported(JSON.parse(body));
		});
		return;
	}
	res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const site = `http://127.0.0.1:${server.address().port}/`;

const steps = [];
const step = (name, ok, detail = "") => {
	steps.push({ name, ok });
	console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await puppeteer.launch({
	browser: "firefox",
	executablePath,
	headless: true,
});
try {
	// The extension drives itself: installed next to this tab, a dev build opens its panel in self-test mode, which
	// runs the steps and posts them to /report (WebDriver BiDi cannot reach extension pages in Firefox).
	const page = await browser.newPage();
	await page.goto(`${site}?oshawatt-selftest`);
	await browser.installExtension(extension);
	const results = await Promise.race([
		report,
		new Promise((_, reject) => setTimeout(() => reject(new Error("no self-test report within 60 s")), 60_000)),
	]);
	for (const { name, ok, detail } of results) step(name, ok, detail);
} finally {
	await browser.close();
	server.close();
}
const failed = steps.filter((s) => !s.ok);
if (failed.length) {
	console.error(`${failed.length} step(s) failed`);
	process.exit(1);
}
