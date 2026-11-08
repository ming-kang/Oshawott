import assert from "node:assert/strict";
import { test } from "node:test";
import { clip, cut, LIMITS, shapeGrid, take, takeWhere } from "../src/page/limits.ts";
import { pageUrl, RefTable } from "../src/page/refs.ts";

const URL_A = "https://example.com/a";
const node = () => ({ isConnected: true });

test("refs resolve within their snapshot and repeat for the same element", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	const a = node();
	refs.begin(URL_A);
	const ref = refs.add(a, URL_A);
	assert.equal(ref, "abcd.1.e1");
	assert.equal(refs.add(a, URL_A), ref);
	assert.equal(refs.resolve(ref, URL_A), a);
});

test("a new snapshot invalidates refs even when numbering repeats", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	refs.begin(URL_A);
	const old = refs.add(node(), URL_A);
	refs.begin(URL_A);
	const next = node();
	const current = refs.add(next, URL_A);
	assert.notEqual(old, current);
	assert.throws(() => refs.resolve(old, URL_A), /earlier snapshot/);
	assert.equal(refs.resolve(current, URL_A), next);
});

test("a ref from another page load never resolves", () => {
	const before = new RefTable<ReturnType<typeof node>>("aaaa");
	before.begin(URL_A);
	const old = before.add(node(), URL_A);
	const after = new RefTable<ReturnType<typeof node>>("bbbb");
	after.begin(URL_A);
	after.add(node(), URL_A);
	assert.throws(() => after.resolve(old, URL_A), /earlier page load/);
});

test("same-document navigation invalidates refs; a fragment change does not", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	const a = node();
	refs.begin(URL_A);
	const ref = refs.add(a, URL_A);
	assert.equal(refs.resolve(ref, `${URL_A}#part`), a);
	assert.throws(() => refs.resolve(ref, "https://example.com/b"), /navigated/);
	assert.equal(pageUrl(`${URL_A}#part`), URL_A);
});

test("returning to the snapshot's URL does not revive its refs", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	refs.begin(URL_A);
	const ref = refs.add(node(), URL_A);
	refs.observe("https://example.com/b");
	refs.observe(`${URL_A}#part`);
	assert.throws(() => refs.resolve(ref, URL_A), /navigated/);
	const fragment = refs.add(node(), URL_A);
	refs.observe(`${URL_A}#part`);
	assert.doesNotThrow(() => refs.resolve(fragment, URL_A));
});

test("page load ids are long enough not to collide across loads", () => {
	const ids = new Set(Array.from({ length: 20_000 }, () => new RefTable().pageLoad));
	assert.equal(ids.size, 20_000);
	assert.match([...ids][0]!, /^[a-z0-9]{8}$/);
});

test("adding after a navigation starts a new generation", () => {
	const refs = new RefTable<ReturnType<typeof node>>("abcd");
	refs.begin(URL_A);
	const old = refs.add(node(), URL_A);
	const later = "https://example.com/b";
	const ref = refs.add(node(), later);
	assert.equal(ref, "abcd.2.e1");
	assert.throws(() => refs.resolve(old, later), /earlier snapshot/);
});

test("removed elements and malformed refs are refused", () => {
	const refs = new RefTable<{ isConnected: boolean }>("abcd");
	const a = { isConnected: true };
	refs.begin(URL_A);
	const ref = refs.add(a, URL_A);
	a.isConnected = false;
	assert.throws(() => refs.resolve(ref, URL_A), /no longer on the page/);
	assert.throws(() => refs.resolve("e1", URL_A), /not an element ref/);
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
