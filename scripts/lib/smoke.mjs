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

/** Page-action fixture: every control logs what a user's action would have done to it. */
export const ACTIONS_PAGE = `<!doctype html><title>Actions fixture</title>
<label for="size">Size</label><select id="size" onchange="log('select:'+this.value)"><option value="s">Small</option><option value="m">Medium</option><option value="l" disabled>Large</option></select>
<form onsubmit="event.preventDefault();log('submit:'+this.q.value)"><input name="q" aria-label="Query"><input type="submit" value="Search"></form>
<a href="#pic"><img alt="Picture link" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="></a>
<label><input type="checkbox" id="agree" checked> Agree</label>
<button id="menu" aria-expanded="false" onpointerdown="this.setAttribute('aria-expanded','true');log('pointerdown')" onmousedown="log('mousedown')" onclick="log('click')">Menu</button>
<button id="off" disabled>Off</button>
<div id="hover" role="button" tabindex="0" onmouseover="log('hover')">Hover me</div>
<div id="rich" contenteditable="true" aria-label="Rich">old</div>
<button id="later" onclick="setTimeout(()=>{const p=document.createElement('p');p.id='late';p.textContent='Arrived';document.body.append(p)},300)">Later</button>
<input id="keys" aria-label="Keys" onkeydown="log('key:'+event.key+(event.shiftKey?'+shift':''))">
<input id="secret" type="password" aria-label="Secret" value="hunter2">
<pre id="log"></pre><script>function log(t){document.getElementById('log').textContent+=t+' '}</script>`;

/** Page-inspection fixture: bounded data, a scoped region, dynamic content and same-document navigation. */
export const INSPECT_PAGE = `<!doctype html><title>Inspect fixture</title>
<section id="scope"><h2>Inside region</h2><button id="inside">Inside</button>
<table id="in-table"><tr><th>Key</th></tr><tr><td>scoped-cell</td></tr></table></section>
<section id="outside"><p>Outside region</p><button>Outside</button></section>
<table id="scores"><caption>Scores</caption><thead><tr><th>Name</th><th>Score</th></tr></thead>
<tbody><tr style="display:none"><td>hidden row</td><td>-1</td></tr>${Array.from({ length: 60 }, (_, i) => `<tr><td>row ${i}</td><td>${i}</td></tr>`).join("")}</tbody></table>
<div role="grid" id="aria"><div role="row"><span role="columnheader">Col</span></div><div role="row"><span role="gridcell">aria-cell</span></div></div>
<ul id="fruits"><li>Apple<ul><li>Green</li></ul></li><li hidden>Hidden fruit</li><li>Pear</li></ul>
<dl id="terms"><div><dt>Term</dt><dd>Definition</dd></div><div style="display:none"><dt>Hidden term</dt><dd>Hidden definition</dd></div><dt>Other</dt><dd>Second</dd></dl>
${Array.from({ length: 30 }, (_, i) => `<i class="many">${i}</i>`).join("")}
<div id="long" data-long="${"v".repeat(800)}">${"long text ".repeat(100)}</div>
<form id="login"><input id="pw" type="PassWord" value="hunter2"><template><div><template><input type="password" value="nested-secret"></template></div><input type="password" value="template-secret"></template></form>
<div id="named"></div><script>document.getElementById("named").setAttribute("x".repeat(5000), "1")</script>
<button id="add" onclick="document.body.insertAdjacentHTML('beforeend','<div id=dyn data-x=made style=width:120px;height:30px;color:rgb(1,2,3)>made</div>')">Add</button>
<button id="count" onclick="n.textContent=Number(n.textContent)+1">Count</button><output id="n">0</output>
<button id="spa" onclick="history.pushState({},'','/inspect?spa=1')">Route</button>
<button id="bounce" onclick="const back=location.pathname+location.search;history.pushState({},'','/inspect?away=1');history.pushState({},'',back)">Bounce</button>
<button id="hash" onclick="location.hash='part'">Hash</button>`;

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
		if (req.url === "/actions") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ACTIONS_PAGE);
		if (req.url?.startsWith("/inspect")) {
			const strict = req.url === "/inspect-csp" ? { "content-security-policy": "default-src 'none'; script-src 'none'" } : {};
			return res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...strict }).end(INSPECT_PAGE);
		}
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
		// The slash form of a redirecting address, which fetch tries before giving up, is not a page here.
		if (req.url?.startsWith("/redirect-")) return res.writeHead(404, { "access-control-allow-origin": "*" }).end();
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
