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
