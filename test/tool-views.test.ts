import assert from "node:assert/strict";
import { test } from "node:test";
import { defineToolView, registerToolView, resolveToolLook, toolViewFor } from "../src/panel/tool-views.ts";

// These assertions stay language-independent (icons, argument summaries, fallbacks) so they hold
// whichever language the test runner resolves.

test("an unknown tool falls back to its raw name and the generic icon", () => {
	const look = resolveToolLook("some_future_tool", { anything: 1 });
	assert.equal(look.icon, "tool");
	assert.equal(look.label, "some_future_tool");
	assert.equal(look.meta, undefined);
	assert.equal(toolViewFor("some_future_tool"), undefined);
});

test("a registered view drives the header icon and argument summary", () => {
	assert.equal(resolveToolLook("fetch", { url: "https://ex.com/p?q=1" }).icon, "download");
	assert.equal(resolveToolLook("fetch", { url: "https://ex.com/p?q=1" }).meta, "ex.com");
	assert.equal(resolveToolLook("page_click", { ref: "e7" }).meta, "e7");
	assert.equal(resolveToolLook("ls", {}).meta, "/workspace");
});

test("a view can vary its icon and summary with the arguments", () => {
	assert.equal(resolveToolLook("tab_navigate", { back: true }).icon, "back");
	assert.equal(resolveToolLook("tab_navigate", { back: true }).meta, "");
	assert.equal(resolveToolLook("tab_navigate", { url: "https://ex.com/" }).icon, "globe");
});

test("a family of names shares one view", () => {
	assert.deepEqual(resolveToolLook("read", { path: "a.md" }), resolveToolLook("read_text", { path: "a.md" }));
	assert.equal(resolveToolLook("read_text", { path: "a.md" }).meta, "a.md");
});

test("registration is idempotent and overwrites by name rather than accumulating", () => {
	const first = defineToolView({ name: "zz_probe_tool", icon: "code", label: "probe", argsMeta: () => "one" });
	registerToolView(first);
	assert.equal(resolveToolLook("zz_probe_tool", {}).meta, "one");
	registerToolView(first);
	assert.equal(resolveToolLook("zz_probe_tool", {}).meta, "one");
	registerToolView(defineToolView({ name: "zz_probe_tool", icon: "code", label: "probe2", argsMeta: () => "two" }));
	assert.equal(resolveToolLook("zz_probe_tool", {}).meta, "two");
});
