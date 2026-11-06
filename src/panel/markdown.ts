// A Markdown parser for model answers: the subset chat models write (paragraphs, headings, lists, quotes, fenced code,
// tables, emphasis, code spans, links). It returns a tree, never HTML: the panel builds DOM nodes from it, and text
// stays text. Links keep only `http(s):` and `mailto:` targets. Pure, so it runs in tests without a DOM.

export type Inline =
	| { readonly t: "text"; readonly text: string }
	| { readonly t: "code"; readonly text: string }
	| { readonly t: "strong" | "em" | "del"; readonly children: Inline[] }
	| { readonly t: "link"; readonly href: string; readonly children: Inline[] }
	| { readonly t: "br" };

export type Align = "left" | "center" | "right" | null;

export type Block =
	| { readonly t: "p"; readonly children: Inline[] }
	| { readonly t: "h"; readonly level: number; readonly children: Inline[] }
	/** `open`: the fence is not closed yet (an answer still streaming). */
	| { readonly t: "code"; readonly lang: string; readonly text: string; readonly open: boolean }
	| { readonly t: "quote"; readonly children: Block[] }
	| { readonly t: "list"; readonly ordered: boolean; readonly start: number; readonly items: Block[][] }
	| { readonly t: "table"; readonly align: Align[]; readonly head: Inline[][]; readonly rows: Inline[][][] }
	| { readonly t: "hr" };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

export function parseMarkdown(source: string): Block[] {
	return parseBlocks(source.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function startsBlock(line: string) {
	return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line);
}

function isTableStart(lines: readonly string[], i: number) {
	return lines[i]!.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes("-");
}

function cells(row: string): string[] {
	let line = row.trim();
	if (line.startsWith("|")) line = line.slice(1);
	if (line.endsWith("|") && !line.endsWith("\\|")) line = line.slice(0, -1);
	return line.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseBlocks(lines: readonly string[]): Block[] {
	const out: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (!line.trim()) {
			i++;
			continue;
		}
		let m: RegExpExecArray | null;

		if ((m = FENCE.exec(line))) {
			const fence = m[1]!;
			const body: string[] = [];
			let open = true;
			for (i++; i < lines.length; i++) {
				const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
				if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
					open = false;
					i++;
					break;
				}
				body.push(lines[i]!);
			}
			out.push({ t: "code", lang: m[2] ?? "", text: body.join("\n"), open });
			continue;
		}
		if ((m = HEADING.exec(line))) {
			out.push({ t: "h", level: m[1]!.length, children: parseInline(m[2]!) });
			i++;
			continue;
		}
		if (HR.test(line)) {
			out.push({ t: "hr" });
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length && (m = QUOTE.exec(lines[i]!))) {
				inner.push(m[1]!);
				i++;
			}
			out.push({ t: "quote", children: parseBlocks(inner) });
			continue;
		}
		if (isTableStart(lines, i)) {
			const head = cells(line);
			const align = cells(lines[i + 1]!).map((rule): Align =>
				rule.startsWith(":") && rule.endsWith(":") ? "center" : rule.endsWith(":") ? "right" : rule.startsWith(":") ? "left" : null,
			);
			const rows: Inline[][][] = [];
			for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) {
				const row = cells(lines[i]!);
				rows.push(head.map((_, c) => parseInline(row[c] ?? "")));
			}
			out.push({ t: "table", align: head.map((_, c) => align[c] ?? null), head: head.map((cell) => parseInline(cell)), rows });
			continue;
		}
		if ((m = ITEM.exec(line))) {
			const indent = m[1]!.length;
			const ordered = /\d/.test(m[2]!);
			const start = ordered ? Number.parseInt(m[2]!, 10) : 1;
			const items: Block[][] = [];
			while (i < lines.length) {
				const item = ITEM.exec(lines[i]!);
				if (!item || item[1]!.length !== indent || /\d/.test(item[2]!) !== ordered) break;
				const content = item[1]!.length + item[2]!.length + 1;
				const body = [item[3]!];
				let sibling = false;
				for (i++; i < lines.length; i++) {
					const next = lines[i]!;
					if (!next.trim()) {
						let j = i + 1;
						while (j < lines.length && !lines[j]!.trim()) j++;
						if (j < lines.length && indentOf(lines[j]!) >= content) {
							body.push("");
							continue;
						}
						const after = j < lines.length ? ITEM.exec(lines[j]!) : null;
						if (after && after[1]!.length === indent && /\d/.test(after[2]!) === ordered) {
							i = j;
							sibling = true;
						}
						break;
					}
					const depth = indentOf(next);
					if (depth >= content || (depth > indent && ITEM.test(next))) body.push(next.slice(Math.min(depth, content)));
					else if (!startsBlock(next) && !isTableStart(lines, i)) body.push(next.trim());
					else break;
				}
				items.push(parseBlocks(body));
				if (!sibling && (i >= lines.length || !ITEM.test(lines[i]!))) break;
			}
			out.push({ t: "list", ordered, start, items });
			continue;
		}

		const paragraph = [line.trim()];
		for (i++; i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!) && !isTableStart(lines, i); i++) {
			paragraph.push(lines[i]!.trim());
		}
		out.push({ t: "p", children: parseInline(paragraph.join("\n")) });
	}
	return out;
}

export function safeUrl(url: string): string | undefined {
	const trimmed = url.trim();
	return /^(?:https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
}

const WORD = /[\p{L}\p{N}]/u;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;

/** The index of the marker that closes an emphasis opened before `from`, or -1. */
function closing(source: string, marker: string, from: number): number {
	const single = marker.length === 1;
	for (let j = source.indexOf(marker, from); j !== -1; j = source.indexOf(marker, j + 1)) {
		if (j === from) continue;
		if (/\s/.test(source[j - 1]!)) continue;
		if (single && (source[j + 1] === marker || source[j - 1] === marker)) continue;
		if (marker[0] === "_" && WORD.test(source[j + marker.length] ?? "")) continue;
		return j;
	}
	return -1;
}

/** The index of the `]` matching the `[` at `open`, or -1. */
function bracket(source: string, open: number): number {
	let depth = 0;
	for (let j = open; j < source.length; j++) {
		if (source[j] === "\\") j++;
		else if (source[j] === "[") depth++;
		else if (source[j] === "]" && --depth === 0) return j;
	}
	return -1;
}

export function parseInline(source: string): Inline[] {
	const out: Inline[] = [];
	let text = "";
	const flush = () => {
		if (text) out.push({ t: "text", text });
		text = "";
	};
	let i = 0;
	while (i < source.length) {
		const c = source[i]!;
		if (c === "\\" && ESCAPABLE.test(source[i + 1] ?? "")) {
			text += source[i + 1];
			i += 2;
			continue;
		}
		if (c === "\n") {
			flush();
			out.push({ t: "br" });
			i++;
			continue;
		}
		if (c === "`") {
			const run = /^`+/.exec(source.slice(i))![0];
			const end = source.indexOf(run, i + run.length);
			if (end !== -1) {
				flush();
				const code = source.slice(i + run.length, end);
				out.push({ t: "code", text: /^ .* $/.test(code) ? code.slice(1, -1) : code });
				i = end + run.length;
				continue;
			}
			text += run;
			i += run.length;
			continue;
		}
		if (c === "*" || c === "_" || c === "~") {
			const marker = source[i + 1] === c ? c + c : c;
			const after = source[i + marker.length] ?? "";
			const opens = after && !/\s/.test(after) && !(c === "_" && WORD.test(source[i - 1] ?? "")) && marker !== "~";
			const end = opens ? closing(source, marker, i + marker.length) : -1;
			if (end !== -1) {
				flush();
				const kind = c === "~" ? "del" : marker.length === 2 ? "strong" : "em";
				out.push({ t: kind, children: parseInline(source.slice(i + marker.length, end)) });
				i = end + marker.length;
				continue;
			}
			text += marker;
			i += marker.length;
			continue;
		}
		if (c === "[") {
			const close = bracket(source, i);
			if (close !== -1 && source[close + 1] === "(") {
				const end = source.indexOf(")", close + 2);
				if (end !== -1) {
					const target = source.slice(close + 2, end).trim().split(/\s+/)[0] ?? "";
					const href = safeUrl(target.replace(/^<(.*)>$/, "$1"));
					const label = parseInline(source.slice(i + 1, close));
					flush();
					if (href) out.push({ t: "link", href, children: label });
					else out.push(...label);
					i = end + 1;
					continue;
				}
			}
		}
		if (c === "<") {
			const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(source.slice(i));
			if (auto) {
				flush();
				out.push({ t: "link", href: auto[1]!, children: [{ t: "text", text: auto[1]! }] });
				i += auto[0].length;
				continue;
			}
		}
		if ((c === "h" || c === "H") && !/[A-Za-z0-9]/.test(source[i - 1] ?? "")) {
			const bare = /^https?:\/\/[^\s<>"'`，。；、！？）】」]+/i.exec(source.slice(i));
			if (bare) {
				let url = bare[0].replace(/[.,:;!?'"\]]+$/, "");
				// A closing parenthesis belongs to the URL only when the URL opened one.
				while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
				flush();
				out.push({ t: "link", href: url, children: [{ t: "text", text: url }] });
				i += url.length;
				continue;
			}
		}
		text += c;
		i++;
	}
	flush();
	return out;
}

/**
 * A streaming answer cut mid-span: drops a marker the stream ended in the middle of (`*` of a coming `**`), and closes
 * a code span or bold run that the last paragraph opened, so it shows styled instead of as raw markers until the rest
 * arrives. Not inside an open code fence.
 */
export function closeDangling(source: string): string {
	if ((source.match(/^ {0,3}(?:```|~~~)/gm)?.length ?? 0) % 2 === 1) return source;
	let closed = source.replace(/[*_~`]+$/, "");
	const paragraph = closed.slice(closed.lastIndexOf("\n\n") + 1);
	if ((paragraph.match(/`/g)?.length ?? 0) % 2 === 1) closed += "`";
	const outside = paragraph.replace(/`[^`]*`?/g, "");
	if ((outside.match(/\*\*/g)?.length ?? 0) % 2 === 1) closed += "**";
	return closed;
}

/** The plain text of inline nodes (for titles and copying). */
export function plainText(nodes: readonly Inline[]): string {
	return nodes.map((node) => ("text" in node ? node.text : node.t === "br" ? "\n" : plainText(node.children))).join("");
}
