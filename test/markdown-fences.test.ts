import assert from "node:assert/strict";
import { test } from "node:test";
import { fenceEnricher, registerFence, type FenceEnricher } from "../src/panel/markdown-fences.ts";

test("lookup is case-insensitive and uses only the first info-string token", () => {
	const registered: FenceEnricher = { maxLength: 750, render() {} };
	registerFence("Diagram-B", registered);
	assert.equal(fenceEnricher("diagram-b"), registered);
	assert.equal(fenceEnricher("  DIAGRAM-B  "), registered);
	assert.equal(fenceEnricher("diagram-b theme=dark"), registered);
	assert.equal(fenceEnricher("   "), undefined);
});
