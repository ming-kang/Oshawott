import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveToolLook, toolViewFor } from "../src/panel/tool-views.ts";

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
