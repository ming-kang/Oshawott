import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { firefoxPath } from "./lib/browsers.mjs";
import { dist, freshDir } from "./lib/paths.mjs";
import { modelApi, TEST_DOWNLOAD, TEST_LARGE_DOWNLOAD, testSite } from "./lib/site.mjs";
import { checklist, until } from "./lib/smoke.mjs";

let reported;
const report = new Promise((resolve) => (reported = resolve));
const models = modelApi();
const site = await testSite({
	routes: {
		...models.routes,
		"POST /report": (req, res) => {
			let body = "";
			req.on("data", (chunk) => (body += chunk)).on("end", () => {
				res.writeHead(204, { "access-control-allow-origin": "*" }).end();
				reported(JSON.parse(body));
			});
		},
	},
});

const run = checklist();
const { step } = run;
const artifacts = await freshDir("test", "firefox");
const downloads = join(artifacts, "downloads");
await mkdir(downloads);
const browser = await puppeteer.launch({
	browser: "firefox", executablePath: firefoxPath(), headless: true,
	extraPrefsFirefox: {
		"browser.download.folderList": 2,
		"browser.download.dir": downloads,
		"browser.helperApps.neverAsk.saveToDisk": "application/octet-stream",
		"browser.download.alwaysOpenPanel": false,
	},
});
let deadline;
try {
	// The extension drives itself: installed next to this tab, a dev build opens its panel in self-test mode, which
	// runs the steps and posts them to /report (WebDriver BiDi cannot reach extension pages in Firefox).
	const page = await browser.newPage();
	await page.goto(`${site.url}?oshawott-selftest`);
	await browser.installExtension(dist("firefox"));
	const results = await Promise.race([
		report,
		new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("no self-test report within 60 s")), 60_000); }),
	]);
	for (const { name, ok, detail } of results.steps) step(name, ok, detail);
	step("local model API receives an actual high-thinking chat request", models.requests.some((request) => request.model === "local-reasoning" && request.reasoning_effort === "high"), `${models.requests.length} request(s)`);
	for (const [key, name] of [["screenshot", "panel"], ["filesScreenshot", "files"]]) {
		if (!results[key]) continue;
		const path = join(artifacts, `${name}.png`);
		await writeFile(path, Buffer.from(results[key].split(",")[1], "base64"));
		console.log(`  screenshot: ${path}`);
	}
	if (!run.failed) {
		const downloaded = await until("a real Firefox download", () => readFile(join(downloads, "items.json"), "utf8"));
		step("Firefox saves the downloaded file", downloaded === TEST_DOWNLOAD, `${Buffer.byteLength(downloaded)} UTF-8 bytes`);
		const large = await until("a large Firefox download", () => readFile(join(downloads, "large.json"), "utf8"));
		const measured = JSON.parse(await until("the large file statistics", () => readFile(join(downloads, "large.json.stats.json"), "utf8")));
		step("Firefox saves the complete large file and its Code Mode result", large === TEST_LARGE_DOWNLOAD && measured.characters === TEST_LARGE_DOWNLOAD.length, `${measured.characters} characters`);
		const redirects = site.redirectHits();
		step("redirect destinations receive no request", redirects.get302 === 1 && redirects.post307 === 1 && redirects.target === 0, JSON.stringify(redirects));
	}
} finally {
	clearTimeout(deadline);
	await browser.close();
	site.close();
}
run.finish();
