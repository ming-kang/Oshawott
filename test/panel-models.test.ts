import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSummary } from "../src/contracts/chat.ts";
import { clampThinking, compactTokens, configuredProviders, modelName, sameModel, shownModel, supportedThinkingLevels } from "../src/panel/models.ts";

const model = (id: string, name: string, vision: boolean): ProviderSummary["models"][number] => ({
	id, name, vision, contextWindow: 128_000, maxTokens: 16_384, thinkingLevels: ["off"], manual: false,
});
const provider = (id: string, name: string, configured: boolean, models: ProviderSummary["models"]): ProviderSummary => ({
	id, name, kind: "builtin", baseUrl: "https://example.test/v1", api: null, configured, auth: configured ? "api_key" : null, apiKey: true, oauth: null, models, refreshing: false, discoveryError: null,
});
const providers: ProviderSummary[] = [
	provider("offline", "Offline", false, [model("unavailable", "Unavailable", false)]),
	provider("empty", "Empty", true, []),
	provider("first", "First", true, [model("one", "Model One", true), model("two", "Model Two", false)]),
	provider("second", "Second", true, [model("three", "Model Three", true)]),
];

test("model fallback skips disconnected and empty providers, preserving a connected choice", () => {
	assert.deepEqual(configuredProviders(providers).map((provider) => provider.id), ["empty", "first", "second"]);
	assert.deepEqual(shownModel(providers, undefined), { provider: "first", modelId: "one" });
	assert.deepEqual(shownModel(providers, { provider: "offline", modelId: "unavailable" }), { provider: "first", modelId: "one" });
	const choice = { provider: "second", modelId: "three" };
	assert.equal(shownModel(providers, choice), choice);
	assert.deepEqual(providers[0]?.models, [model("unavailable", "Unavailable", false)], "policy does not mutate provider state");
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

test("thinking choices come from the selected model and clamp without mutating metadata", () => {
	const reasoning = { ...model("reasoning", "Reasoning", false), thinkingLevels: ["off", "low", "high"] as ("off" | "low" | "high")[] };
	const list = [provider("reasoning", "Reasoning", true, [reasoning])];
	const ref = { provider: "reasoning", modelId: "reasoning" };
	assert.deepEqual(supportedThinkingLevels(list, ref), ["off", "low", "high"]);
	assert.equal(clampThinking(supportedThinkingLevels(list, ref), "high"), "high");
	assert.equal(clampThinking(supportedThinkingLevels(list, ref), "medium"), "high");
	assert.equal(clampThinking(supportedThinkingLevels(list, ref), "minimal"), "low");
	assert.equal(clampThinking(["off"], "max"), "off");
	assert.deepEqual(reasoning.thinkingLevels, ["off", "low", "high"]);
	assert.equal(compactTokens(128_000), "128K");
	assert.equal(compactTokens(1_500_000), "1.5M");
});
