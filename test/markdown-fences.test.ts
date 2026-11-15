import assert from "node:assert/strict";
import { test } from "node:test";
import { fenceEnricher, fenceLanguage, registerFence, type FenceEnricher } from "../src/panel/markdown-fences.ts";

const enricher = (maxLength = 1000): FenceEnricher => ({ maxLength, render() {} });

test("an enricher registered for a language is returned for that language", () => {
	registerFence("diagram-a", enricher(500));
	assert.equal(fenceEnricher("diagram-a")?.maxLength, 500);
});

test("lookup is case-insensitive and uses only the first info-string token", () => {
	const registered = enricher(750);
	registerFence("Diagram-B", registered);
	assert.equal(fenceEnricher("diagram-b"), registered);
	assert.equal(fenceEnricher("  DIAGRAM-B  "), registered);
	assert.equal(fenceEnricher("diagram-b theme=dark"), registered);
});

test("registering a language again replaces its previous enricher", () => {
	registerFence("diagram-c", enricher(10));
	registerFence("diagram-c", enricher(20));
	assert.equal(fenceEnricher("diagram-c")?.maxLength, 20);
});

test("an unregistered, empty, or whitespace language has no enricher", () => {
	assert.equal(fenceEnricher("diagram-missing"), undefined);
	assert.equal(fenceEnricher(""), undefined);
	assert.equal(fenceEnricher("   "), undefined);
});

test("fenceLanguage reduces an info string to its canonical, lower-cased language token", () => {
	assert.equal(fenceLanguage("  TypeScript  "), "typescript");
	assert.equal(fenceLanguage("js {1,3}"), "js");
	assert.equal(fenceLanguage(""), "");
	assert.equal(fenceLanguage("   "), "");
});
