import assert from "node:assert/strict";
import { test } from "node:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderProfile } from "../src/contracts/chat.ts";
import { discoverModels, modelFromConfig, normalizeBaseUrl, normalizeProfile } from "../src/engine/provider-discovery.ts";

const base: ProviderProfile = {
	id: "custom-test", name: "Test", baseUrl: "https://models.test/v1", api: "openai-completions", models: [],
};
const refresh = (key = "secret-key"): RefreshModelsContext => ({
	credential: { type: "api_key", key }, allowNetwork: true, signal: new AbortController().signal,
	publish: async () => true,
});

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

test("OpenAI discovery reads raw metadata and never forwards ambient credentials", async () => {
	const profile: ProviderProfile = { ...base, models: [
		{ id: "remote", name: "Override", contextWindow: 10_000, maxTokens: 1_000, vision: true, thinkingLevels: ["off", "high"] },
	] };
	let request: { url: unknown; init?: RequestInit } | undefined;
	const models = await discoverModels(profile, refresh(), async (url, init) => {
		request = { url, init };
		return Response.json({ data: [
			{ id: "remote", name: "Remote", context_length: 99_000, reasoning: true },
			{ id: "vision", display_name: "Vision", architecture: { input_modalities: ["text", "image"] }, supported_features: ["reasoning"] },
		] });
	});
	assert.equal(request?.url, "https://models.test/v1/models");
	assert.equal(request?.init?.credentials, "omit");
	assert.equal(request?.init?.redirect, "error");
	assert.equal(request?.init?.referrerPolicy, "no-referrer");
	assert.equal((request?.init?.headers as Record<string, string>).authorization, "Bearer secret-key");
	assert.equal(models.length, 2);
	assert.equal(models[0]?.name, "Remote");
	assert.equal(models[0]?.contextWindow, 99_000);
	assert.deepEqual(models[0]?.input, ["text"]);
	assert.equal(models[1]?.name, "Vision");
	assert.equal(models[1]?.reasoning, true);
	assert.deepEqual(models[1]?.input, ["text", "image"]);
});

test("Anthropic discovery uses its versioned endpoint and errors omit secrets and response bodies", async () => {
	const profile = { ...base, baseUrl: "https://anthropic.test", api: "anthropic-messages" as const };
	let headers: Record<string, string> | undefined;
	await discoverModels(profile, refresh(), async (url, init) => {
		assert.equal(url, "https://anthropic.test/v1/models");
		headers = init?.headers as Record<string, string>;
		return Response.json({ data: [{ id: "claude", display_name: "Claude" }] });
	});
	assert.equal(headers?.["x-api-key"], "secret-key");
	assert.equal(headers?.["anthropic-version"], "2023-06-01");
	assert.equal(headers?.authorization, undefined);
	await assert.rejects(discoverModels(profile, refresh(), async () => new Response("secret-key in error body", { status: 401 })), (error) => {
		assert.match(String(error), /HTTP 401/);
		assert.equal(String(error).includes("secret-key"), false);
		return true;
	});
});
