import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
const SHARED_STATICS = [
	"static/panel.html", ...ICONS, ...BRAND_SVGS, "node_modules/quickjs-wasi/quickjs.wasm",
	// Binary distributions retain notices even though bundled JS omits license banners.
	"static/MARKDOWN-NOTICES.txt", "static/fonts/COMMIT-MONO-LICENSE.txt",
];
const statics = {
	chromium: ["static/engine.html", ...SHARED_STATICS],
	firefox: SHARED_STATICS,
};

for (const target of targets.length ? targets : Object.keys(bundles)) {
	if (!(target in bundles)) throw new Error(`Unknown target ${target}`);
	const out = await freshDir(target);
	const chunks = new Set();
	for (const [file, [entry, format]] of Object.entries(bundles[target])) {
		const result = await build({
			entryPoints: { [file.replace(/\.js$/, "")]: join(root, entry) },
			outdir: out,
			// Markdown enrichers are local lazy chunks, not remote code or a startup cost.
			splitting: file === "panel.js",
			chunkNames: "chunks/[name]-[hash]",
			metafile: true,
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
		for (const output of Object.keys(result.metafile.outputs).filter((path) => path.endsWith(".js"))) {
			const leaked = staticNodeImports(await readFile(output, "utf8"));
			if (leaked.length) throw new Error(`${output} imports ${[...new Set(leaked)].join(", ")} when it loads`);
			if (output.replaceAll("\\", "/").includes("/chunks/")) chunks.add(output);
		}
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
		// Self-hosted font files ride along next to the bundled stylesheet.
		loader: {".woff2": "file"},
		logLevel: "warning",
	});
	// KaTeX CSS and fonts are fetched only when a formula is present. Both targets support WOFF2;
	// omit the legacy WOFF/TTF alternatives rather than distributing three copies of every font.
	await build({
		entryPoints: [join(root, "node_modules/katex/dist/katex-swap.css")],
		outfile: join(out, "katex.css"), bundle: true, minify: !dev, legalComments: "none",
		loader: { ".woff2": "file" }, assetNames: "fonts/[name]-[hash]", logLevel: "warning",
		plugins: [{ name: "katex-woff2", setup(build) {
			build.onLoad({ filter: /katex-swap\.css$/ }, async ({ path }) => ({
				contents: (await readFile(path, "utf8")).replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\([^)]*\)/g, ""),
				loader: "css", resolveDir: dirname(path),
			}));
		} }],
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
	for (const file of chunks) sizes.push(`${file.replaceAll("\\", "/").split("/").at(-1)} ${Math.round((await stat(file)).size / 1024)} KiB (lazy)`);
	console.log(`dist/${target}: ${sizes.join(", ")}`);
}
