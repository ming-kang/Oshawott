import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSummary } from "../src/contracts/chat.ts";
import { configuredProviders, modelName, sameModel, shownModel } from "../src/panel/models.ts";

const providers: ProviderSummary[] = [
	{ id: "offline", name: "Offline", configured: false, models: [{ id: "unavailable", name: "Unavailable" }] },
	{ id: "empty", name: "Empty", configured: true, models: [] },
	{ id: "first", name: "First", configured: true, models: [{ id: "one", name: "Model One" }, { id: "two", name: "Model Two" }] },
	{ id: "second", name: "Second", configured: true, models: [{ id: "three", name: "Model Three" }] },
];

test("model fallback skips disconnected and empty providers, preserving a connected choice", () => {
	assert.deepEqual(configuredProviders(providers).map((provider) => provider.id), ["empty", "first", "second"]);
	assert.deepEqual(shownModel(providers, undefined), { provider: "first", modelId: "one" });
	assert.deepEqual(shownModel(providers, { provider: "offline", modelId: "unavailable" }), { provider: "first", modelId: "one" });
	const choice = { provider: "second", modelId: "three" };
	assert.equal(shownModel(providers, choice), choice);
	assert.deepEqual(providers[0]?.models, [{ id: "unavailable", name: "Unavailable" }], "policy does not mutate provider state");
});

test("no fallback keeps a configured model reference for error feedback, or leaves an empty choice empty", () => {
	const choice = { provider: "offline", modelId: "unavailable" };
	assert.equal(shownModel([], choice), choice);
	assert.equal(shownModel([providers[1]!], undefined), undefined);
	assert.equal(shownModel([], undefined), undefined);
});

test("model labels and equality use provider and model id, not object identity", () => {
	const choice = { provider: "first", modelId: "two" };
	assert.equal(modelName(providers, choice), "Model Two");
	assert.equal(modelName(providers, { provider: "first", modelId: "unknown" }), "unknown");
	assert.equal(sameModel(choice, { ...choice }), true);
	assert.equal(sameModel(choice, { provider: "second", modelId: "two" }), false);
	assert.equal(sameModel(choice, { provider: "first", modelId: "one" }), false);
	assert.equal(sameModel(choice, undefined), false);
	assert.equal(sameModel(undefined, undefined), true);
});
