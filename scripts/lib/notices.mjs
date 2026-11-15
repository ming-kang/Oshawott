import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./paths.mjs";

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md", "license", "license.md"];

/** Include exactly the packages present in this target's initial and lazy JS chunks. */
export function bundledPackages(metafile) {
	const packages = new Set();
	for (const output of Object.values(metafile.outputs)) {
		if (!output.entryPoint && !Object.keys(output.inputs).length) continue;
		for (const input of Object.keys(output.inputs)) {
			const match = input.replaceAll("\\", "/").match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
			if (match) packages.add(match[1]);
		}
	}
	return packages;
}

export async function panelNotices(packages) {
	const sections = [];
	for (const name of [...packages].sort((a, b) => a.localeCompare(b))) {
		const directory = join(root, "node_modules", name);
		const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
		let text;
		for (const candidate of LICENSE_FILES) {
			try {
				text = await readFile(join(directory, candidate), "utf8");
				break;
			} catch {}
		}
		sections.push([
			"=".repeat(80), `${name}@${manifest.version}`, `License: ${manifest.license ?? "See package metadata"}`,
			text?.trim() ?? "The npm archive contains no standalone license file; see the package metadata and repository.",
		].join("\n"));
	}
	return `Third-party notices for Oshawott's Vue panel and lazy enrichers\n\nGenerated from the packages present in this target's bundled JavaScript chunks.\nMarkdown parser, highlighter, KaTeX and font notices are additionally retained in MARKDOWN-NOTICES.txt.\n\n${sections.join("\n\n")}\n`;
}
