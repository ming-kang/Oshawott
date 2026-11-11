import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import { manifestFor } from "../src/manifest.ts";
import { freshDir, root } from "./lib/paths.mjs";
import { piNodeOnly, piOAuth, staticNodeImports } from "./lib/pi-ai.mjs";

const args = process.argv.slice(2);
const dev = args.includes("--dev");
const unknownOption = args.find((arg) => arg.startsWith("--") && arg !== "--dev");
if (unknownOption) throw new Error(`Unknown option ${unknownOption}`);
const targets = args.filter((a) => !a.startsWith("--"));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const bundles = {
	chromium: {
		"background.js": ["src/entries/chromium-background.ts", "esm"],
		"engine.js": ["src/entries/chromium-engine.ts", "esm"],
		"panel.js": ["src/panel/main.ts", "esm"],
		"page.js": ["src/page/main.ts", "iife"],
		"codemode-worker.js": ["src/engine/codemode-worker.ts", "esm"],
	},
	firefox: {
		"background.js": ["src/entries/firefox-background.ts", "esm"],
		"panel.js": ["src/panel/main.ts", "esm"],
		"page.js": ["src/page/main.ts", "iife"],
		"codemode-worker.js": ["src/engine/codemode-worker.ts", "esm"],
	},
};
const ICONS = [16, 32, 48, 96, 128].map((size) => `static/icons/icon-${size}.png`);
const BRAND_SVGS = ["icon.svg", "icon-small.svg", "mascot.svg"].map((name) => `static/icons/${name}`);
const statics = {
	chromium: ["static/engine.html", "static/panel.html", ...ICONS, ...BRAND_SVGS, "node_modules/quickjs-wasi/quickjs.wasm"],
	firefox: ["static/panel.html", ...ICONS, ...BRAND_SVGS, "node_modules/quickjs-wasi/quickjs.wasm"],
};

for (const target of targets.length ? targets : Object.keys(bundles)) {
	if (!(target in bundles)) throw new Error(`Unknown target ${target}`);
	const out = await freshDir(target);
	for (const [file, [entry, format]] of Object.entries(bundles[target])) {
		await build({
			entryPoints: [join(root, entry)],
			outfile: join(out, file),
			bundle: true,
			format,
			platform: "browser",
			target: target === "chromium" ? "chrome120" : "firefox140",
			minify: !dev,
			sourcemap: dev ? "inline" : false,
			legalComments: "none",
			define: { __OSHAWOTT_DEV__: JSON.stringify(dev) },
			// SDK code paths for Node (proxies, files) that a browser never takes.
			external: ["node:*"],
			plugins: [piOAuth(), piNodeOnly()],
			logLevel: "warning",
		});
		const leaked = staticNodeImports(await readFile(join(out, file), "utf8"));
		if (leaked.length) throw new Error(`${target}/${file} imports ${[...new Set(leaked)].join(", ")} when it loads`);
	}
	// Resolve the ordered CSS imports into the one stylesheet linked by panel.html.
	await build({
		entryPoints: [join(root, "static/panel.css")],
		outfile: join(out, "panel.css"),
		bundle: true,
		target: target === "chromium" ? "chrome120" : "firefox140",
		// Keep the source rule sequence intact in release builds as well as --dev.
		minify: false,
		sourcemap: dev ? "inline" : false,
		legalComments: "none",
		logLevel: "warning",
	});
	await mkdir(join(out, "icons"), { recursive: true });
	for (const file of statics[target]) {
		const name = file.startsWith("static/icons/") ? `icons/${file.split("/").at(-1)}` : file.split("/").at(-1);
		await copyFile(join(root, file), join(out, name));
	}
	await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifestFor(target, version, { dev }), null, 2)}\n`);

	const sizes = [];
	for (const file of [...Object.keys(bundles[target]), "quickjs.wasm"]) {
		sizes.push(`${file} ${Math.round((await stat(join(out, file))).size / 1024)} KiB`);
	}
	console.log(`dist/${target}: ${sizes.join(", ")}`);
}
