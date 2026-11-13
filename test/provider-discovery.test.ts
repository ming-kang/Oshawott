import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderProfile } from "../src/contracts/chat.ts";
import { modelFromConfig, normalizeBaseUrl, normalizeProfile, probeProviderModels } from "../src/engine/provider-discovery.ts";

const base: ProviderProfile = {
	id: "custom-test", name: "Test", baseUrl: "https://models.test/v1", api: "openai-completions", models: [],
};

test("profile validation normalizes endpoints and preserves explicit model capabilities", () => {
	assert.equal(normalizeBaseUrl(" https://models.test/v1/ "), "https://models.test/v1");
	assert.throws(() => normalizeBaseUrl("ftp://models.test"), /HTTP or HTTPS/);
	assert.throws(() => normalizeBaseUrl("https://user:secret@models.test/v1"), /cannot contain credentials/);
	assert.throws(() => normalizeBaseUrl("https://models.test/v1?key=secret"), /cannot contain a query/);
	const normalized = normalizeProfile({ ...base, models: [
		{ id: " one ", name: "", contextWindow: 10_000, maxTokens: 1_000, vision: true, thinkingLevels: ["high", "off", "high"] },
	] });
	assert.equal(normalized.models[0]?.id, "one");
	assert.equal(normalized.models[0]?.name, "one");
	assert.deepEqual(normalized.models[0]?.thinkingLevels, ["off", "high"]);
	const model = modelFromConfig(normalized.models[0]!, normalized);
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
	assert.deepEqual(model.thinkingLevelMap, { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null });
});

test("OpenAI probing reads rich metadata, takes conservative limits and never forwards ambient credentials", async () => {
	let request: { url: unknown; init?: RequestInit } | undefined;
	const result = await probeProviderModels({ baseUrl: base.baseUrl, api: base.api, key: "secret-key" }, async (url, init) => {
		request = { url, init };
		return Response.json({ data: [
			{ id: "vision", display_name: "Vision", architecture: { input_modalities: ["text", "image"] }, supported_features: ["reasoning"] },
			{ id: "remote", name: "Remote", context_length: 99_000, top_provider: { context_length: 64_000 }, max_tokens: 8_000, reasoning: true },
		] });
	});
	assert.equal(request?.url, "https://models.test/v1/models");
	assert.equal(request?.init?.credentials, "omit");
	assert.equal(request?.init?.redirect, "error");
	assert.equal(request?.init?.referrerPolicy, "no-referrer");
	assert.equal((request?.init?.headers as Record<string, string>).authorization, "Bearer secret-key");
	assert.equal(result.truncated, false);
	assert.deepEqual(result.models.map((model) => model.id), ["remote", "vision"]);
	assert.equal(result.models[0]?.name, "Remote");
	assert.equal(result.models[0]?.contextWindow, 64_000);
	assert.equal(result.models[0]?.maxTokens, 8_000);
	assert.equal(result.models[0]?.vision, false);
	assert.equal(result.models[1]?.name, "Vision");
	assert.equal(result.models[1]?.vision, true);
	assert.deepEqual(result.models[1]?.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
});

test("Anthropic probing follows cursor pages, supports OpenAI-style fallback and omits secrets from errors", async () => {
	const requests: { url: string; headers: Record<string, string> }[] = [];
	const paginated = await probeProviderModels({ baseUrl: "https://anthropic.test", api: "anthropic-messages", key: "secret-key" }, async (url, init) => {
		requests.push({ url: String(url), headers: init?.headers as Record<string, string> });
		if (String(url).includes("after_id=c1")) {
			return Response.json({ data: [{ id: "claude-haiku", display_name: "Claude Haiku" }], has_more: false });
		}
		return Response.json({ data: [{ id: "claude-sonnet", display_name: "Claude Sonnet" }], has_more: true, last_id: "c1" });
	});
	assert.equal(requests[0]?.url, "https://anthropic.test/v1/models");
	assert.equal(requests[0]?.headers["x-api-key"], "secret-key");
	assert.equal(requests[0]?.headers["anthropic-version"], "2023-06-01");
	assert.equal(requests[0]?.headers.authorization, undefined);
	assert.match(requests[1]?.url ?? "", /after_id=c1/);
	assert.deepEqual(paginated.models.map((model) => model.id), ["claude-haiku", "claude-sonnet"]);

	// Anthropic-compatible gateway that rejects x-api-key on /anthropic/v1/models falls back to Bearer on root /v1/models.
	const retryRequests: { url: string; headers: Record<string, string> }[] = [];
	const fallback = await probeProviderModels({ baseUrl: "https://gateway.test/anthropic", api: "anthropic-messages", key: "secret-key" }, async (url, init) => {
		const headers = init?.headers as Record<string, string>;
		retryRequests.push({ url: String(url), headers });
		if (String(url) === "https://gateway.test/anthropic/v1/models") return new Response("not found", { status: 404 });
		assert.equal(url, "https://gateway.test/v1/models");
		assert.equal(headers.authorization, "Bearer secret-key");
		return Response.json({ data: [{ id: "deepseek-chat" }] });
	});
	assert.equal(retryRequests.length, 2);
	assert.deepEqual(fallback.models.map((model) => model.id), ["deepseek-chat"]);

	await assert.rejects(
		probeProviderModels({ baseUrl: "https://anthropic.test", api: "anthropic-messages", key: "secret-key" }, async () => new Response("secret-key in error body", { status: 401 })),
		(error) => {
			assert.match(String(error), /HTTP 401/);
			assert.equal(String(error).includes("secret-key"), false);
			return true;
		},
	);
});
