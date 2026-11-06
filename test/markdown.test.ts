// The panel's Markdown parser: the tree it builds from what chat models write, and that only safe link targets survive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDangling, type Inline, parseInline, parseMarkdown, plainText } from "../src/panel/markdown.ts";

const links = (nodes: readonly Inline[]): string[] =>
	nodes.flatMap((node) => (node.t === "link" ? [node.href] : "children" in node ? links(node.children) : []));

test("blocks: heading, paragraph, fenced code, quote, rule", () => {
	const blocks = parseMarkdown("# Title\n\nSome *text*\nnext line\n\n```js\nconst a = 1;\n```\n\n> quoted\n\n---");
	assert.deepEqual(
		blocks.map((b) => b.t),
		["h", "p", "code", "quote", "hr"],
	);
	assert.deepEqual(blocks[2], { t: "code", lang: "js", text: "const a = 1;", open: false });
	const paragraph = blocks[1] as { children: Inline[] };
	assert.deepEqual(
		paragraph.children.map((n) => n.t),
		["text", "em", "br", "text"],
	);
});

test("an unclosed fence is code to the end, marked open (an answer still streaming)", () => {
	const [block] = parseMarkdown("```\nline 1\nline 2");
	assert.deepEqual(block, { t: "code", lang: "", text: "line 1\nline 2", open: true });
});

test("lists: ordered with a start, nested, and items separated by blank lines", () => {
	const [list] = parseMarkdown("3. three\n4. four\n   - nested a\n   - nested b\n\n5. five");
	assert.equal(list?.t, "list");
	if (list?.t !== "list") return;
	assert.equal(list.ordered, true);
	assert.equal(list.start, 3);
	assert.equal(list.items.length, 3);
	const nested = list.items[1]!.find((b) => b.t === "list");
	assert.equal(nested?.t === "list" && nested.items.length, 2);
});

test("tables: header, alignment, cells with escaped pipes", () => {
	const [table] = parseMarkdown("| a | b |\n|:--|--:|\n| 1 | x \\| y |");
	assert.equal(table?.t, "table");
	if (table?.t !== "table") return;
	assert.deepEqual(table.align, ["left", "right"]);
	assert.equal(plainText(table.rows[0]![1]!), "x | y");
});

test("inline: code spans keep their text, emphasis nests, snake_case stays text", () => {
	const nodes = parseInline("use `a*b*c` and **bold _it_** in snake_case_name");
	assert.deepEqual(nodes[1], { t: "code", text: "a*b*c" });
	const bold = nodes.find((n) => n.t === "strong");
	assert.equal(bold?.t === "strong" && bold.children.some((c) => c.t === "em"), true);
	assert.equal(plainText(nodes), "use a*b*c and bold it in snake_case_name");
});

test("links: only http(s) and mailto targets become links; others keep their label as text", () => {
	const nodes = parseInline(
		"[ok](https://example.com/a) [bad](javascript:alert(1)) [mail](mailto:x@example.com) <https://auto.example> see https://bare.example/path).",
	);
	assert.deepEqual(links(nodes), ["https://example.com/a", "mailto:x@example.com", "https://auto.example", "https://bare.example/path"]);
	assert.match(plainText(nodes), /bad/);
	assert.doesNotMatch(JSON.stringify(nodes), /javascript:/);
});

test("a bare URL ends before closing punctuation, keeping balanced parentheses", () => {
	assert.deepEqual(links(parseInline("(see https://en.wikipedia.org/wiki/Otter_(disambiguation))")), [
		"https://en.wikipedia.org/wiki/Otter_(disambiguation)",
	]);
	assert.deepEqual(links(parseInline("链接：https://example.com/页面，然后")), ["https://example.com/页面"]);
});

test("a streaming answer's dangling code span or bold run is closed, but not inside an open fence", () => {
	assert.equal(closeDangling("I read **127.0"), "I read **127.0**");
	assert.equal(closeDangling("call `page_snap"), "call `page_snap`");
	assert.equal(closeDangling("**done** and `ok`"), "**done** and `ok`");
	assert.equal(closeDangling("I read *"), "I read ");
	assert.equal(closeDangling("I read **bold**"), "I read **bold**");
	assert.equal(closeDangling("```js\nconst a = `x"), "```js\nconst a = `x");
});
