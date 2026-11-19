const IMAGE_MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
	webp: "image/webp", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml",
};
const TEXT_EXTENSIONS = new Set("txt md json jsonl csv tsv log js mjs ts tsx py css html xml yaml yml sh sql toml ini".split(" "));
/** Only grammars bundled by markdown-highlight.ts; unknown extensions fall back to plain text. */
const LANGUAGES: Record<string, string> = {
	json: "json", jsonl: "json",
	js: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", py: "python",
	css: "css", html: "xml", xml: "xml", yaml: "yaml", yml: "yaml", sh: "bash", sql: "sql",
};
const SNIFF_WINDOW = 8192;

export type PreviewKind =
	| { type: "image"; mime: string }
	| { type: "text"; language?: string }
	| { type: "binary" };

/** Text when the first 8 KB hold no NUL and decode as UTF-8, regardless of extension. */
function sniffText(bytes: Uint8Array): boolean {
	let end = Math.min(bytes.length, SNIFF_WINDOW);
	// A multi-byte sequence sliced by the window edge is not evidence of binary data.
	for (let i = end - 1; i >= 0 && end - i <= 4; i--) {
		const byte = bytes[i]!;
		if (byte < 0x80) break;
		if (byte >= 0xC0) {
			const length = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : 2;
			if (i + length > end) end = i;
			break;
		}
	}
	const head = bytes.subarray(0, end);
	if (head.includes(0)) return false;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(head);
		return true;
	} catch {
		return false;
	}
}

export function languageForPath(path: string): string | undefined {
	const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
	return LANGUAGES[extension];
}

export function previewKind(path: string, bytes: Uint8Array): PreviewKind {
	const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
	const mime = IMAGE_MIME[extension];
	if (mime) return { type: "image", mime };
	if (TEXT_EXTENSIONS.has(extension)) return { type: "text", language: languageForPath(path) };
	return sniffText(bytes) ? { type: "text" } : { type: "binary" };
}
