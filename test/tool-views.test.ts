import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCodemodeResult, parseSnapshotResult, resolveToolLook, toolViewFor } from "../src/panel/tool-views.ts";

test("an unknown tool falls back to its raw name and the generic icon", () => {
	const look = resolveToolLook("some_future_tool", { anything: 1 });
	assert.equal(look.icon, "tool");
	assert.equal(look.label, "some_future_tool");
	assert.equal(look.meta, undefined);
	assert.equal(toolViewFor("some_future_tool"), undefined);
});

test("a view can vary its icon and summary with the arguments", () => {
	assert.equal(resolveToolLook("tab_navigate", { back: true }).icon, "back");
	assert.equal(resolveToolLook("tab_navigate", { back: true }).meta, "");
	assert.equal(resolveToolLook("tab_navigate", { url: "https://ex.com/p?q=1" }).icon, "globe");
	assert.equal(resolveToolLook("tab_navigate", { url: "https://ex.com/p?q=1" }).meta, "ex.com");
});

test("an action names the element it touched and keeps its input", () => {
	const element = { element: { role: "textbox", name: "Email" } };
	assert.equal(toolViewFor("page_click")?.resultMeta?.(element, "p1.e4"), "Email (textbox)");
	assert.equal(toolViewFor("page_type")?.resultMeta?.(element, "“a@b.c”"), "Email (textbox) · “a@b.c”");
	assert.equal(toolViewFor("page_click")?.resultMeta?.({ element: { role: "button", name: "" } }, "p1.e4"), "button");
	assert.equal(toolViewFor("page_scroll")?.resultMeta?.(undefined, "300px"), undefined, "without an element the card keeps the argument summary");
});

test("the codemode result header parses into status, wall time and output", () => {
	const done = parseCodemodeResult('Script completed\nWall time 1.5 seconds\nOutput:\n{"a":1}');
	assert.deepEqual(done, { ok: true, seconds: "1.5", output: '{"a":1}' });
	const failed = parseCodemodeResult("Script failed\nWall time 0.2 seconds\nOutput:\nError: boom\n    at run");
	assert.equal(failed?.ok, false);
	assert.equal(failed?.output, "Error: boom\n    at run");
	assert.equal(parseCodemodeResult("Script sandbox failed: QuickJS died"), undefined);
});

test("the snapshot result needs its url, title and element records", () => {
	const parsed = parseSnapshotResult(JSON.stringify({
		url: "https://ex.com/", title: "T", text: "body",
		elements: [{ ref: "e1", role: "button", name: "Go" }, { ref: "e2" }, { ref: "e3", role: "link", name: "", href: "#" }],
	}));
	assert.equal(parsed?.elements.length, 2);
	assert.deepEqual(parsed?.elements[0], { ref: "e1", role: "button", name: "Go" });
	assert.equal(parseSnapshotResult('{"title":"T","elements":[]}'), undefined);
});
