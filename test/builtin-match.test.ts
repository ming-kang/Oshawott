import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelConfig, ModelSummary, ProviderSummary } from "../src/contracts/chat.ts";
import { computeBuiltinChanges, matchBuiltinModels } from "../src/panel/builtin-match.ts";

const modelSummary = (overrides: Partial<ModelSummary> & Pick<ModelSummary, "id">): ModelSummary => ({
	name: overrides.id,
	vision: false,
	contextWindow: 128_000,
	maxTokens: 16_384,
	thinkingLevels: ["off"],
	...overrides,
});

const builtinProvider = (id: string, name: string, models: ModelSummary[]): ProviderSummary => ({
	id, name, kind: "builtin", baseUrl: "https://example.test/v1", api: null,
	configured: false, auth: null, apiKey: true, oauth: null, models, refreshing: false, discoveryError: null,
});

const providers: ProviderSummary[] = [
	builtinProvider("custom-ignored", "Custom", [modelSummary({ id: "claude-sonnet-4-5" })]),
	{ ...builtinProvider("openrouter", "OpenRouter", [
		modelSummary({ id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", contextWindow: 200_000, maxTokens: 64_000, vision: true, thinkingLevels: ["off", "low", "medium", "high"] }),
	]) },
	builtinProvider("anthropic", "Anthropic", [
		modelSummary({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, maxTokens: 64_000, vision: true, thinkingLevels: ["off", "minimal", "low", "medium", "high"] }),
		modelSummary({ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, maxTokens: 64_000, vision: true }),
	]),
	builtinProvider("openai", "OpenAI", [
		modelSummary({ id: "gpt-5", name: "GPT-5", contextWindow: 400_000, maxTokens: 128_000, vision: true, thinkingLevels: ["off", "minimal", "low", "medium", "high"] }),
	]),
];

// Adjust the custom fixture kind to "custom" so we verify non-builtins are excluded.
providers[0] = { ...providers[0]!, kind: "custom" };

const formatters = {
	formatBoolean: (value: boolean) => (value ? "Yes" : "No"),
	formatThinkingLevel: (level: string) => level,
	unsetLabel: "not set",
};

test("matchBuiltinModels ranks exact, normalized, and fuzzy matches with first-party providers first", () => {
	const exact = matchBuiltinModels(providers, "claude-sonnet-4-5");
	assert.equal(exact[0]?.providerId, "anthropic");
	assert.equal(exact[0]?.tier, "exact");
	assert.equal(exact[1]?.providerId, "openrouter");
	assert.equal(exact[1]?.tier, "normalized");

	const fuzzy = matchBuiltinModels(providers, "haiku");
	assert.equal(fuzzy[0]?.model.id, "claude-haiku-4-5");
	assert.equal(fuzzy[0]?.tier, "fuzzy");

	const empty = matchBuiltinModels(providers, "");
	assert.equal(empty.some((item) => item.providerId === "anthropic"), true);
	assert.equal(empty.some((item) => item.providerId === "openrouter"), false);
	assert.equal(empty.some((item) => item.providerId === "custom-ignored"), false);
});

test("computeBuiltinChanges pre-checks default fields, preserves customized fields, and never mutates model ID", () => {
	const ref = providers[2]!.models[0]!;
	const blankModel: ModelConfig = {
		id: "my-sonnet-gateway",
		name: "my-sonnet-gateway",
		contextWindow: 128_000,
		maxTokens: 16_384,
		vision: false,
		thinkingLevels: ["off"],
	};
	const blankChanges = computeBuiltinChanges(blankModel, ref, formatters);
	assert.deepEqual(
		blankChanges.map((item) => [item.field, item.checked, item.same]),
		[
			["name", true, false],
			["contextWindow", true, false],
			["maxTokens", true, false],
			["vision", true, false],
			["thinkingLevels", true, false],
		],
	);

	// A gateway that already returned custom context/output limits keeps those unchecked by default,
	// while still pre-checking missing vision and thinking capabilities.
	const anthropicGatewayModel: ModelConfig = {
		id: "claude-opus-5-5-high",
		name: "Custom Opus Name",
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		vision: false,
		thinkingLevels: ["off"],
	};
	const gatewayChanges = computeBuiltinChanges(anthropicGatewayModel, ref, formatters);
	assert.deepEqual(
		gatewayChanges.map((item) => [item.field, item.checked, item.same]),
		[
			["name", false, false],
			["contextWindow", false, false],
			["maxTokens", false, false],
			["vision", true, false],
			["thinkingLevels", true, false],
		],
	);

	for (const change of gatewayChanges) {
		if (change.checked) change.apply(anthropicGatewayModel);
	}
	assert.equal(anthropicGatewayModel.id, "claude-opus-5-5-high");
	assert.equal(anthropicGatewayModel.name, "Custom Opus Name");
	assert.equal(anthropicGatewayModel.contextWindow, 1_000_000);
	assert.equal(anthropicGatewayModel.maxTokens, 128_000);
	assert.equal(anthropicGatewayModel.vision, true);
	assert.deepEqual(anthropicGatewayModel.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);

	// After applying all changes to a model, identical fields report same=true and checked=false.
	const sameRefModel: ModelConfig = {
		id: "my-sonnet-gateway",
		name: ref.name,
		contextWindow: ref.contextWindow,
		maxTokens: ref.maxTokens,
		vision: ref.vision,
		thinkingLevels: [...ref.thinkingLevels],
	};
	const sameChanges = computeBuiltinChanges(sameRefModel, ref, formatters);
	assert.equal(sameChanges.every((item) => item.same && !item.checked), true);
});
