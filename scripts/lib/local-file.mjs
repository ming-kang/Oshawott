import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A real local document for browser smoke tests; Tabs APIs cannot open file:// URLs in Firefox. */
export async function writeLocalFile(directory) {
	const path = join(directory, "local-page.html");
	await writeFile(path, `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Oshawott local document</title></head>
<body><main><h1>Local file smoke marker</h1><p>This document was already open before the agent read it.</p></main></body>
</html>
`);
	return {
		url: pathToFileURL(path).href,
		title: "Oshawott local document",
		text: "Local file smoke marker",
	};
}
