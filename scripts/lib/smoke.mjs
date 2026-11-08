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

export const TEST_DOWNLOAD = `${JSON.stringify({ items: [1, 2, 3], note: "Oshawott 文件" })}\n`;
export const TEST_LARGE_DOWNLOAD = JSON.stringify({ padding: "x".repeat(1_100_000), ending: "complete" });

/** A real OpenAI-compatible discovery and streaming endpoint for the browser model-management flow. */
export function modelApi() {
	const requests = [];
	const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,OPTIONS" };
	const authorized = (req) => req.headers.authorization === "Bearer local-key";
	return { requests, routes: {
		"OPTIONS /v1/models": (_req, res) => res.writeHead(204, cors).end(),
		"OPTIONS /v1/chat/completions": (_req, res) => res.writeHead(204, cors).end(),
		"GET /v1/models": (req, res) => {
			if (!authorized(req)) return res.writeHead(401, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ error: { message: "unauthorized" } }));
			res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [
				{ id: "local-reasoning", object: "model", reasoning: true, input: ["text", "image"], context_length: 65536, max_output_tokens: 8192 },
			] }));
		},
		"POST /v1/chat/completions": (req, res) => {
			if (!authorized(req)) return res.writeHead(401, cors).end();
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				const parsed = JSON.parse(body);
				requests.push(parsed);
				const model = parsed.model ?? "unknown";
				const reasoning = parsed.reasoning_effort ?? "off";
				const chunk = (delta, finishReason = null) => `data: ${JSON.stringify({
					id: "chatcmpl-oshawott", object: "chat.completion.chunk", created: 1_700_000_000, model,
					choices: [{ index: 0, delta, finish_reason: finishReason }],
				})}\n\n`;
				const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
				res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" }).end(
					chunk({ role: "assistant", content: `Local answer: model=${model} reasoning=${reasoning}` })
					+ chunk({}, "stop")
					+ `data: ${JSON.stringify({ id: "chatcmpl-oshawott", object: "chat.completion.chunk", created: 1_700_000_000, model, choices: [], usage })}\n\n`
					+ "data: [DONE]\n\n",
				);
			});
		},
	} };
}

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
