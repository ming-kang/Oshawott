import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, type ModelConfig, type ProviderProfile, type ThinkingLevel } from "../contracts/chat.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MAX_DISCOVERY_RESPONSE = 4 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 20_000;

export function normalizeBaseUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The provider URL must use HTTP or HTTPS.");
	if (url.username || url.password) throw new Error("The provider URL cannot contain credentials.");
	if (url.search || url.hash) throw new Error("The provider URL cannot contain a query or fragment.");
	return url.href.replace(/\/+$/, "");
}

export function normalizeProfile(profile: ProviderProfile): ProviderProfile {
	const id = profile.id.trim();
	const name = profile.name.trim();
	if (!id) throw new Error("The provider ID cannot be empty.");
	if (!name) throw new Error("The provider name cannot be empty.");
	const models = profile.models.map((model) => {
		const modelId = model.id.trim();
		if (!modelId) throw new Error("A model ID cannot be empty.");
		const levels = THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level));
		return {
			...model,
			id: modelId,
			name: model.name.trim() || modelId,
			contextWindow: Math.floor(model.contextWindow),
			maxTokens: Math.floor(model.maxTokens),
			thinkingLevels: levels.length ? levels : ["off" as const],
		};
	});
	if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("Model IDs must be unique within a provider.");
	for (const model of models) {
		if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) throw new Error(`Invalid context window for ${model.id}.`);
		if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) throw new Error(`Invalid output limit for ${model.id}.`);
	}
	return { id, name, baseUrl: normalizeBaseUrl(profile.baseUrl), api: profile.api, models };
}

export function modelFromConfig(config: ModelConfig, profile: ProviderProfile): Model<Api> {
	const selected = new Set(config.thinkingLevels);
	const reasoning = config.thinkingLevels.some((level) => level !== "off");
	return {
		id: config.id,
		name: config.name,
		api: profile.api,
		provider: profile.id,
		baseUrl: profile.baseUrl,
		input: config.vision ? ["text", "image"] : ["text"],
		cost: { ...ZERO_COST },
		reasoning,
		contextWindow: config.contextWindow,
		maxTokens: config.maxTokens,
		thinkingLevelMap: Object.fromEntries(THINKING_LEVELS.map((level) => [level, selected.has(level) ? level : null])),
	};
}

function numberField(entry: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = entry[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	}
	return undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function discoveredThinkingLevels(entry: Record<string, unknown>, reasoning: boolean): ThinkingLevel[] {
	const declared = stringList(entry.thinking_levels ?? entry.thinkingLevels)
		.filter((level): level is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(level));
	if (declared.length) return THINKING_LEVELS.filter((level) => declared.includes(level));
	return reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
}

function discoveredModel(entry: Record<string, unknown>, profile: ProviderProfile): Model<Api> | undefined {
	if (typeof entry.id !== "string" || !entry.id.trim()) return undefined;
	const id = entry.id.trim();
	const architecture = typeof entry.architecture === "object" && entry.architecture !== null ? entry.architecture as Record<string, unknown> : {};
	const topProvider = typeof entry.top_provider === "object" && entry.top_provider !== null ? entry.top_provider as Record<string, unknown> : {};
	const contextWindow = numberField(entry, ["context_window", "context_length", "max_context_tokens"])
		?? numberField(topProvider, ["context_length"]) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = numberField(entry, ["max_output_tokens", "max_completion_tokens", "max_tokens"])
		?? numberField(topProvider, ["max_completion_tokens"]) ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	const inputModalities = [
		...stringList(entry.input), ...stringList(entry.input_modalities), ...stringList(entry.supported_modalities),
		...stringList(architecture.input_modalities),
	];
	const capabilities = typeof entry.capabilities === "object" && entry.capabilities !== null ? entry.capabilities as Record<string, unknown> : {};
	const vision = inputModalities.some((item) => item === "image" || item === "image_url" || item.endsWith("/image"));
	const reasoning = entry.reasoning === true || capabilities.reasoning === true
		|| stringList(entry.supported_features).some((item) => item.toLowerCase().includes("reasoning"));
	const name = typeof entry.display_name === "string" && entry.display_name.trim() ? entry.display_name.trim()
		: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id;
	return modelFromConfig({ id, name, contextWindow, maxTokens, vision, thinkingLevels: discoveredThinkingLevels(entry, reasoning) }, profile);
}

function discoveryUrl(profile: ProviderProfile): string {
	if (profile.api !== "anthropic-messages") return `${profile.baseUrl}/models`;
	return profile.baseUrl.endsWith("/v1") ? `${profile.baseUrl}/models` : `${profile.baseUrl}/v1/models`;
}

/** Discover through Pi-AI's refresh context. Errors deliberately omit response bodies, headers and credentials. */
export async function discoverModels(
	profile: ProviderProfile,
	context: RefreshModelsContext,
	fetcher: typeof fetch = fetch,
): Promise<Model<Api>[]> {
	const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
	const headers: Record<string, string> = profile.api === "anthropic-messages"
		? { accept: "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) }
		: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
	let response: Response;
	const signal = AbortSignal.any([context.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]);
	try {
		response = await fetcher(discoveryUrl(profile), {
			headers, signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
		});
	} catch (error) {
		if (context.signal.aborted) throw error;
		throw new Error("Model discovery could not reach the provider. Check the URL and extension permission.");
	}
	if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}.`);
	const text = await response.text();
	if (text.length > MAX_DISCOVERY_RESPONSE) throw new Error("The model discovery response is too large.");
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error("The provider returned an invalid model list.");
	}
	if (typeof body !== "object" || body === null) throw new Error("The provider returned an invalid model list.");
	const container = body as Record<string, unknown>;
	const rows = Array.isArray(container.data) ? container.data : Array.isArray(container.models) ? container.models : undefined;
	if (!rows) throw new Error("The provider returned an invalid model list.");
	const models = new Map<string, Model<Api>>();
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const discovered = discoveredModel(row as Record<string, unknown>, profile);
		if (!discovered) continue;
		// Persist the upstream shape. Provider reads apply the current manual overrides, so cached data cannot resurrect an old override.
		models.set(discovered.id, discovered);
	}
	return [...models.values()];
}
