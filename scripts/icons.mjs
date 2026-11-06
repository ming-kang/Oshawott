// Renders static/icons/icon.svg to the PNG sizes the manifests use (Chromium does not take SVG icons):
//   node scripts/icons.mjs
// The PNGs are committed; run this again after changing the SVG.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { chromiumPath, root } from "./lib/smoke.mjs";

const SIZES = [16, 32, 48, 96, 128];
const svg = await readFile(join(root, "static", "icons", "icon.svg"));
const browser = await puppeteer.launch({ executablePath: chromiumPath(), headless: true });
try {
	const page = await browser.newPage();
	for (const size of SIZES) {
		await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
		await page.setContent(
			`<body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${svg.toString("base64")}"></body>`,
		);
		const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
		await writeFile(join(root, "static", "icons", `icon-${size}.png`), png);
		console.log(`static/icons/icon-${size}.png`);
	}
} finally {
	await browser.close();
}
