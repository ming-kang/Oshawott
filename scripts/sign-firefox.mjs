import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dist, root } from "./lib/paths.mjs";

// After `npm run package`: Mozilla signs dist/firefox on AMO's unlisted channel, so release Firefox installs the xpi
// this adds to dist/signed (kept across runs: AMO signs each version once). Arguments go on to `web-ext sign`, such as
// `--api-proxy=<url>`.
for (const name of ["WEB_EXT_API_KEY", "WEB_EXT_API_SECRET"]) {
	if (!process.env[name]) throw new Error(`${name} is not set: put your AMO API credentials in .env (docs/distribution.md)`);
}
if (!process.env.npm_execpath) throw new Error("Run this through npm: npm run sign:firefox");
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const signed = dist("signed");
await mkdir(signed, { recursive: true });
const { status, error } = spawnSync(process.execPath, [
	process.env.npm_execpath, "exec", "--yes", "--package=web-ext@10", "--", "web-ext", "sign", "--channel=unlisted",
	`--source-dir=${dist("firefox")}`, `--artifacts-dir=${signed}`,
	`--upload-source-code=${dist(`oshawott-${version}-source.zip`)}`, ...process.argv.slice(2),
], { stdio: "inherit" });
if (error) throw error;
process.exitCode = status ?? 1;
