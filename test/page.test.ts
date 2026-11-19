import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, cut, shapeGrid, take, takeWhere } from "../src/page/limits.ts";
import { LIMITS } from "../src/tools/page-limits.ts";
import { readback } from "../src/page/dom.ts";
import { pageUrl, RefTable } from "../src/page/refs.ts";
import { renderSnapshot } from "../src/tools/render.ts";

const URL_A = "https://example.com/a";
const node = () => ({ isConnected: true });

test("refs repeat for the same element and survive later and narrower snapshots", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	const a = node();
	const ref = refs.add(a, URL_A);
	assert.equal(ref, "abcd.e1");
	assert.equal(refs.add(a, URL_A), ref);
	// A second snapshot observes the same URL, a subtree snapshot only adds: neither retires `ref`.
	refs.observe(URL_A);
	const next = node();
	const current = refs.add(next, URL_A);
	assert.equal(current, "abcd.e2");
	assert.equal(refs.resolve(ref, URL_A), a);
	assert.equal(refs.resolve(current, URL_A), next);
});

test("a ref from another page load never resolves", () => {
	const before = new RefTable<ReturnType<typeof node>>("aaaa");
	const old = before.add(node(), URL_A);
	const after = new RefTable<ReturnType<typeof node>>("bbbb");
	after.add(node(), URL_A);
	assert.throws(() => after.resolve(old, URL_A), /earlier page load/);
});

test("same-document navigation invalidates refs; a fragment change does not", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	const a = node();
	const ref = refs.add(a, URL_A);
	assert.equal(refs.resolve(ref, `${URL_A}#part`), a);
	assert.throws(() => refs.resolve(ref, "https://example.com/b"), /navigated/);
	assert.equal(pageUrl(`${URL_A}#part`), URL_A);
});

test("returning to an earlier URL does not revive its refs, and numbering keeps counting", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	const old = refs.add(node(), URL_A);
	const ref = refs.add(node(), "https://example.com/b");
	assert.equal(ref, "abcd.e2");
	assert.throws(() => refs.resolve(old, "https://example.com/b"), /navigated/);
	refs.observe(`${URL_A}#part`);
	assert.throws(() => refs.resolve(old, URL_A), /navigated/);
	const fresh = refs.add(node(), URL_A);
	assert.doesNotThrow(() => refs.resolve(fresh, `${URL_A}#part`));
});

test("removed elements and malformed refs are refused", () => {
	const refs = new RefTable<{ isConnected: boolean }>("abcd");
	const a = { isConnected: true };
	const ref = refs.add(a, URL_A);
	a.isConnected = false;
	assert.throws(() => refs.resolve(ref, URL_A), /no longer on the page/);
	assert.throws(() => refs.resolve("e1", URL_A), /not an element ref/);
});

test("a snapshot's text names its elements, marks the element cap and offers text continuation", () => {
	const view = renderSnapshot({
		url: "https://example.com/", title: "Example",
		text: "First chunk", truncated: true, textOffset: 0, totalChars: 50,
		elements: [
			{ ref: "abcd.e1", role: "button", name: "Submit", disabled: true },
			{ ref: "abcd.e2", role: "link", name: "Docs", href: "https://example.com/docs" },
			{ ref: "abcd.e3", role: "input:text", name: "Email", value: "a@b.c" },
			{ ref: "abcd.e4", role: "checkbox", name: "Remember me", checked: true },
			{ ref: "abcd.e5", role: "button", name: "Menu", expanded: false },
		],
		elementsTruncated: true,
	});
	const lines = view.split("\n");
	assert.equal(lines[0], "Title: Example");
	assert.equal(lines[1], "URL: https://example.com/");
	assert.equal(lines[2], "Elements (first 5; more not shown: narrow with ref or selector):");
	assert.ok(view.includes(`[abcd.e1] button "Submit" disabled`));
	assert.ok(view.includes(`[abcd.e2] link "Docs" → https://example.com/docs`));
	assert.ok(view.includes(`[abcd.e3] input:text "Email" value="a@b.c"`));
	assert.ok(view.includes(`[abcd.e4] checkbox "Remember me" checked`));
	assert.ok(view.includes(`[abcd.e5] button "Menu" expanded=false`));
	assert.ok(view.includes("[Text cut at 11 of 50 characters: call page_snapshot with textOffset=11"));
});

test("a field readback reports a value the page changed", () => {
	assert.deepEqual(readback("a@b.c", "a@b.c"), { value: "a@b.c" });
	const back = readback("A@B.C", "a@b.c");
	assert.equal(back.value, "A@B.C");
	assert.match(back.note ?? "", /reformatted or rejected/);
	assert.equal(readback("  padded  ", "padded").value, "padded");
});

test("cut and clip stay inside the bound and keep surrogate pairs whole", () => {
	assert.deepEqual(cut("short", 10), ["short", false]);
	assert.deepEqual(cut("abcdef", 3), ["abc", true]);
	assert.deepEqual(cut("ab😀", 3), ["ab", true]);
	assert.deepEqual(clip("abcdef", 4), ["abc…", true]);
	assert.deepEqual(clip("abcd", 4), ["abcd", false]);
	assert.deepEqual(take([1, 2, 3], 2), [[1, 2], true]);
});

test("takeWhere keeps accepted items and stops right after the limit", () => {
	let read = 0;
	const items = (function* () {
		for (let i = 0; i < 1_000; i++) {
			read++;
			yield i;
		}
	})();
	assert.deepEqual(takeWhere(items, (n) => n % 2 === 0, 3), [[0, 2, 4], true]);
	assert.equal(read, 7);
	assert.deepEqual(takeWhere([1, 3, 4], (n) => n % 2 === 0, 3), [[4], false]);
});

test("a grid takes its header row and is bounded in rows, columns and cells", () => {
	const row = (cells: string[], header = false) => ({ header, cells });
	const grid = shapeGrid([
		row(["Name", " Score\n"], true),
		...Array.from({ length: LIMITS.rows + 5 }, (_, i) => row([`r${i}`, "x".repeat(LIMITS.cell + 5)])),
	]);
	assert.deepEqual(grid.headers, ["Name", "Score"]);
	assert.equal(grid.rows.length, LIMITS.rows);
	assert.equal(grid.rows[0]?.[1]?.length, LIMITS.cell);
	assert.equal(grid.truncated, true);
	const plain = shapeGrid([row(Array.from({ length: LIMITS.columns + 1 }, () => "c"))]);
	assert.deepEqual(plain.headers, []);
	assert.equal(plain.rows[0]?.length, LIMITS.columns);
	assert.equal(plain.truncated, true);
	assert.deepEqual(shapeGrid([]), { headers: [], rows: [], truncated: false });
});
