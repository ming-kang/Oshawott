import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dist, root } from "./lib/paths.mjs";
import { zipDirectory } from "./lib/zip.mjs";

// After `npm run build`: the release builds as archives to hand on (docs/distribution.md says how to install them).
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archives = { chromium: `oshawott-${version}-chromium.zip`, firefox: `oshawott-${version}-firefox.xpi` };
for (const [target, name] of Object.entries(archives)) {
	const manifest = JSON.parse(await readFile(dist(target, "manifest.json"), "utf8"));
	if (manifest.version !== version) throw new Error(`dist/${target} is not a build of ${version}: run npm run build`);
	if (manifest.host_permissions?.includes("<all_urls>")) throw new Error(`dist/${target} is a --dev build: run npm run build`);
	await writeFile(dist(name), await zipDirectory(dist(target)));
	console.log(`dist/${name}`);
}

// AMO reviews bundled code against the source it was built from: the committed tree, as `git archive` gives it.
const source = `oshawott-${version}-source.zip`;
execFileSync("git", ["archive", "--format=zip", `--output=${dist(source)}`, "HEAD"], { cwd: root });
console.log(`dist/${source}`);
if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) {
	console.warn("Uncommitted changes are in the builds but not in the source archive.");
}
