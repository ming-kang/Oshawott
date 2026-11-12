import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASES } from "../src/manifest.ts";
import { dist, freshDir, root } from "./lib/paths.mjs";

// After `npm run package`: Mozilla signs dist/firefox on AMO's unlisted channel, so release Firefox installs it. The
// signed xpi and the update manifest naming it go to dist/signed, for the release to publish (docs/distribution.md).
// Arguments go on to `web-ext sign`, such as `--api-proxy=<url>`.
for (const name of ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"]) {
	if (!process.env[name]) throw new Error(`${name} is not set: put your AMO API credentials in .env (docs/distribution.md)`);
}
if (!process.env.npm_execpath) throw new Error("Run this through npm: npm run sign:firefox");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const amo = await freshDir("amo");
const { status, error } = spawnSync(process.execPath, [
	process.env.npm_execpath, "exec", "--yes", "--package=web-ext@10", "--", "web-ext", "sign", "--channel=unlisted",
	`--source-dir=${dist("firefox")}`, `--artifacts-dir=${amo}`,
	`--upload-source-code=${dist(`oshawott-${version}-source.zip`)}`, ...process.argv.slice(2),
], { stdio: "inherit" });
if (error) throw error;
if (status !== 0) process.exit(status ?? 1);

// web-ext names the file after the AMO slug; a release names it like the other archives.
const downloaded = (await readdir(amo)).filter((name) => name.endsWith(".xpi"));
if (downloaded.length !== 1) throw new Error(`Expected one signed xpi in dist/amo, found ${downloaded.length}`);
const xpi = `oshawott-${version}-firefox.xpi`;
await mkdir(dist("signed"), { recursive: true });
await rename(join(amo, downloaded[0]), dist("signed", xpi));

// Firefox reads this from the latest release (the manifest's update_url) and installs any higher version it names.
const { browser_specific_settings: { gecko } } = JSON.parse(await readFile(dist("firefox", "manifest.json"), "utf8"));
const hash = createHash("sha256").update(await readFile(dist("signed", xpi))).digest("hex");
const updates = { addons: { [gecko.id]: { updates: [
	{ version, update_link: `${RELEASES}/download/v${version}/${xpi}`, update_hash: `sha256:${hash}` },
] } } };
await writeFile(dist("signed", "updates.json"), `${JSON.stringify(updates, null, 2)}\n`);
console.log(`dist/signed/${xpi}\ndist/signed/updates.json`);
