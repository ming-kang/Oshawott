import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { dist } from "./paths.mjs";

/** `OSHAWOTT_CHROME`, else the newest Chromium that Playwright installed. */
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

const FIREFOX = {
	win32: ["C:/Program Files/Mozilla Firefox/firefox.exe", "C:/Program Files (x86)/Mozilla Firefox/firefox.exe"],
	darwin: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
	linux: ["/usr/bin/firefox", "/usr/lib/firefox/firefox"],
};

/** `OSHAWOTT_FIREFOX`, else Firefox where the platform's installer puts it. */
export function firefoxPath() {
	if (process.env.OSHAWOTT_FIREFOX) return process.env.OSHAWOTT_FIREFOX;
	const path = (FIREFOX[process.platform] ?? []).find((p) => existsSync(p));
	if (!path) throw new Error("No Firefox: set OSHAWOTT_FIREFOX");
	return path;
}

/** Headless Chromium with the `dist/chromium` build installed; `evaluateIn` runs an expression in an extension target. */
export async function launchExtension({ args = [] } = {}) {
	const browser = await puppeteer.launch({
		executablePath: chromiumPath(),
		headless: true,
		enableExtensions: [dist("chromium")],
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
