// What the smoke tests and screenshot scripts share: the Chromium to launch, the test page and its server, loading
// dist/chromium, and polling. OSHAWOTT_CHROME names the browser; by default Playwright's cached Chromium.
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

export const root = join(fileURLToPath(import.meta.url), "..", "..", "..");

export function chromiumPath() {
	if (process.env.OSHAWOTT_CHROME) return process.env.OSHAWOTT_CHROME;
	const cache = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? "", ".cache"), "ms-playwright");
	const build = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1) : undefined;
	const path = build && ["chrome-win64/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
		.map((p) => join(cache, build, p))
		.find((p) => existsSync(p));
	if (!path) throw new Error("No Chromium: set OSHAWOTT_CHROME");
	return path;
}

export const TEST_PAGE = `<!doctype html><title>Oshawott test page</title>
<style>body{font:15px/1.5 system-ui;margin:40px}input,button{font:inherit;padding:4px 8px}</style>
<h1>Hello</h1><p>A page for the extension's tests: a search box and a button.</p>
<input id="q" placeholder="Search"><button id="go" onclick="out.textContent='searched: '+q.value">Go</button>
<p id="out">nothing yet</p>`;

/** A small UTF-8 download for the file tools and the Code Mode → files flow. */
export const TEST_DOWNLOAD = `${JSON.stringify({ items: [1, 2, 3], note: "Oshawott 文件" })}\n`;
export const TEST_LARGE_DOWNLOAD = JSON.stringify({ padding: "x".repeat(1_100_000), ending: "complete" });

/** Serves `page` (the test page by default); `routes` adds handlers by method and path. */
export async function testSite({ page = TEST_PAGE, routes = {} } = {}) {
	const redirects = { get302: 0, post307: 0, target: 0 };
	const server = createServer((req, res) => {
		const route = routes[`${req.method} ${req.url}`];
		if (route) return route(req, res);
		if (req.method === "GET" && (req.url === "/items.json" || req.url === "/large.json")) {
			return res.writeHead(200, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" }).end(req.url === "/items.json" ? TEST_DOWNLOAD : TEST_LARGE_DOWNLOAD);
		}
		if (req.url === "/redirect-302" || req.url === "/redirect-307") {
			if (req.method === "GET" && req.url === "/redirect-302") redirects.get302++;
			if (req.method === "POST" && req.url === "/redirect-307") redirects.post307++;
			return res.writeHead(req.url.endsWith("302") ? 302 : 307, { location: `http://127.0.0.1:${server.address().port}/redirect-target`, "access-control-allow-origin": "*" }).end();
		}
		if (req.url === "/redirect-target") {
			redirects.target++;
			return res.writeHead(200, { "access-control-allow-origin": "*" }).end("must not be requested");
		}
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${server.address().port}/`, redirectHits: () => ({ ...redirects }), close: () => server.close() };
}

/** Chromium with dist/chromium loaded: the browser, the service worker's target, the extension id, `evaluateIn`. */
export async function launchExtension({ args = [] } = {}) {
	const browser = await puppeteer.launch({
		executablePath: chromiumPath(),
		headless: true,
		enableExtensions: [join(root, "dist", "chromium")],
		args: ["--no-first-run", "--no-default-browser-check", ...args],
	});
	const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"));
	const id = new URL(worker.url()).host;
	const evaluateIn = async (target, expression) => {
		const session = await target.createCDPSession();
		const { result, exceptionDetails } = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		await session.detach();
		if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
		return result.value;
	};
	return { browser, worker, id, evaluateIn };
}

export async function until(what, read, ms = 15_000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}
