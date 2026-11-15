import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeBlockNode, HeadingNode, ImageNode, LinkNode, ParsedNode, StrongNode } from "stream-markdown-parser";
import { parseMarkdown, safeImageUrl, safeUrl } from "../src/panel/markdown.ts";

function children(node: ParsedNode): ParsedNode[] {
	const n = node as { children?: ParsedNode[]; items?: ParsedNode[]; rows?: ParsedNode[]; cells?: ParsedNode[]; header?: ParsedNode };
	return n.children ?? n.items ?? n.cells ?? (n.rows ? [n.header!, ...n.rows] : []);
}
const walk = (nodes: readonly ParsedNode[]): ParsedNode[] => nodes.flatMap((node) => [node, ...walk(children(node))]);
const ofType = <T extends ParsedNode>(nodes: readonly ParsedNode[], type: T["type"]): T[] => walk(nodes).filter((node) => node.type === type) as T[];
const text = (nodes: readonly ParsedNode[]): string => nodes.map((node) => {
	if (node.type === "text" || node.type === "text_special") return String(node.content);
	if (node.type === "inline_code" || node.type === "code_block") return String(node.code);
	if (node.type === "hardbreak") return "\n";
	return text(children(node));
}).join("");
const links = (source: string, streaming = false) => ofType<LinkNode>(parseMarkdown(source, streaming), "link").map((node) => node.href);

test("an open code fence remains code, and EOF finalizes it without changing the source", () => {
	const source = "```js\nconst a = `x";
	const streaming = parseMarkdown(source, true)[0] as CodeBlockNode;
	assert.equal(streaming.type, "code_block");
	assert.equal(streaming.loading, true);
	assert.equal(streaming.code, "const a = `x");
	const final = parseMarkdown(source)[0] as CodeBlockNode;
	assert.equal(final.loading, false);
	assert.equal(final.code, streaming.code);
});

test("bare URLs stop at CJK punctuation and retain balanced parentheses", () => {
	assert.deepEqual(links("(see https://en.wikipedia.org/wiki/Otter_(disambiguation))"), ["https://en.wikipedia.org/wiki/Otter_(disambiguation)"]);
	assert.deepEqual(links("链接：https://example.com/页面，然后").map(decodeURI), ["https://example.com/页面"]);
});

test("only absolute HTTP(S) and mailto URLs may leave the extension; images are more restricted", () => {
	for (const url of ["javascript:alert(1)", "jav\nascript:alert(1)", "java\u0000script:alert(1)", "data:text/html,x", "file:///private", "//evil.example", "/panel.html", "#settings", "https://", "https://e.com/\u0000x"]) {
		assert.equal(safeUrl(url), undefined, url);
	}
	assert.equal(safeUrl(" https://example.com/a "), "https://example.com/a");
	assert.equal(safeUrl("mailto:x@example.com"), "mailto:x@example.com");
	assert.equal(safeImageUrl("mailto:x@example.com"), undefined);
	assert.equal(safeImageUrl("data:image/svg+xml,<svg/>"), undefined);
	assert.equal(safeImageUrl("https://example.com/p.png"), "https://example.com/p.png");
	assert.deepEqual(links("[bad](javascript:alert(1)) [ok](https://example.com/a) [mail](mailto:x@example.com)"), ["https://example.com/a", "mailto:x@example.com"]);
});

test("an incomplete link remains provisional even if the stream ends before its destination", () => {
	const [link] = ofType<LinkNode>(parseMarkdown("[docs](https://example.com/part", true), "link");
	assert.equal(link!.loading, true);
	assert.equal(text(link!.children), "docs");
	assert.equal(links("[docs](https://example.com/part").length, 0);
	assert.equal(text(parseMarkdown("[docs](https://example.com/part")), "[docs](https://example.com/part");
	assert.equal(text(parseMarkdown("[docs](http")), "[docs](http");
	assert.equal(ofType<LinkNode>(parseMarkdown("[docs](https://example.com/part)", true), "link")[0]!.loading, false);
});

test("unfinished images finalize as literal source, not a guessed link or loadable image", () => {
	const source = "![alt](https://example.com/a.png";
	assert.equal(ofType<ImageNode>(parseMarkdown(source, true), "image")[0]!.loading, true);
	assert.equal(ofType<ImageNode>(parseMarkdown(source), "image").length, 0);
	assert.equal(links(source).length, 0);
	assert.equal(text(parseMarkdown(source)), source);
});

test("finalizing unfinished destinations preserves surrounding formatting and the original URL text", () => {
	const url = "https://example.com/页面";
	const cases = [
		[`**[docs](${url}`, `**[docs](${url}`, 0],
		[`[**docs**](${url}`, `[docs](${url}`, 1],
		[`![alt](${url} \"unfinished title`, `![alt](${url} \"unfinished title`, 0],
		[`[docs](https://example.com/a_(part)`, `[docs](https://example.com/a_(part)`, 0],
	] as const;
	for (const [source, expected, strong] of cases) {
		const nodes = parseMarkdown(source);
		assert.equal(text(nodes), expected, source);
		assert.equal(links(source).length, 0, source);
		assert.equal(ofType<StrongNode>(nodes, "strong").length, strong, source);
	}
	const mixed = `[ok](https://example.com) and ![alt](${url}`;
	assert.equal(text(parseMarkdown(mixed)), `ok and ![alt](${url}`);
	assert.deepEqual(links(mixed), ["https://example.com"]);
});

test("streaming spans receive provisional formatting, while final unmatched markers stay literal", () => {
	assert.equal(ofType<StrongNode>(parseMarkdown("I read **127.0", true), "strong").length, 1);
	assert.equal(ofType<StrongNode>(parseMarkdown("I read **127.0"), "strong").length, 0);
	assert.equal(text(parseMarkdown("I read **127.0")), "I read **127.0");
	assert.equal(text(parseMarkdown("call `page_snap", true)), "call page_snap");
	assert.equal(text(parseMarkdown("call `page_snap")), "call `page_snap");
});

test("setext headings and indented code are parsed without smart punctuation rewriting", () => {
	const nodes = parseMarkdown('Title\n=====\n\n    const x = "a--b";');
	assert.equal((nodes[0] as HeadingNode).level, 1);
	assert.equal((nodes[1] as CodeBlockNode).code, 'const x = "a--b";\n');
	assert.equal(text(parseMarkdown('"quotes" and -- and ...')), '"quotes" and -- and ...');
});

test("dollar prices stay text and explicitly delimited TeX stays math", () => {
	const prices = "The prices are $5 and $10; the range is $100-$200.";
	assert.equal(text(parseMarkdown(prices)), prices);
	assert.equal(walk(parseMarkdown(prices)).some((node) => node.type.startsWith("math_")), false);
	assert.equal(walk(parseMarkdown(String.raw`Use $x^2$ and \(\frac{a}{b}\).`)).filter((node) => node.type === "math_inline").length, 2);
	assert.equal(parseMarkdown("$$\nx^2\n$$")[0]!.type, "math_block");
});

test("later reference and footnote definitions update earlier content and never leak across documents", () => {
	const source = "Read [docs][id] and note[^a].\n\nStable paragraph.";
	assert.equal(links(source, true).length, 0);
	const defined = `${source}\n\n[id]: https://example.com/docs\n[^a]: Helpful note.`;
	const nodes = parseMarkdown(defined, true);
	assert.deepEqual(ofType<LinkNode>(nodes, "link").map((node) => node.href), ["https://example.com/docs"]);
	assert.equal(walk(nodes).some((node) => node.type === "footnote_reference"), true);
	assert.equal(walk(nodes).some((node) => node.type === "footnote"), true);
	assert.equal(links("[docs][id]", true).length, 0);
	assert.equal(walk(parseMarkdown("note[^a]", true)).some((node) => node.type === "footnote_reference"), false);
});

test("every streaming prefix can finalize to the same document as a one-shot parse", () => {
	const source = "# 水水獭\n\n**Read _this_** [docs][ref].\n\n- [x] done\n- [ ] pending\n\n| A | B |\n|---|---|\n| 1 | `x` |\n\n```ts\nconst x = 1;\n```\n\n$x^2$\n\n[ref]: https://example.com\n";
	const expected = parseMarkdown(source);
	for (let end = 1; end < source.length; end++) parseMarkdown(source.slice(0, end), true);
	assert.deepEqual(parseMarkdown(source), expected);
});
