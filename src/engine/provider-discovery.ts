import type { Api, Model } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, type ModelApi, type ModelConfig, type ProbeModelsResult, type ProviderProfile, type ThinkingLevel } from "../contracts/chat.ts";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MAX_DISCOVERY_RESPONSE = 4 * 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 20_000;
const MAX_PROBED_MODELS = 2_000;
const MAX_ANTHROPIC_PAGES = 5;

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

const CONTEXT_WINDOW_FIELDS = [
	"context_window",
	"context_window.tokens",
	"context_length",
	"top_provider.context_length",
	"max_input_tokens",
	"max_context_length",
	"max_model_len",
	"context_size",
	"metadata.context_length",
];
const MAX_TOKENS_FIELDS = [
	"max_output_tokens",
	"max_completion_tokens",
	"top_provider.max_completion_tokens",
	"max_tokens",
	"max_output_length",
];
const INPUT_MODALITY_FIELDS = ["input", "input_modalities", "supported_modalities", "architecture.input_modalities", "modalities.input"];
const IMAGE_FLAG_FIELDS = ["supports_vision", "enable_vision_input", "capabilities.vision", "capabilities.image_input.supported"];
const REASONING_FLAG_FIELDS = ["reasoning", "supports_reasoning", "enable_reason", "capabilities.reasoning", "capabilities.thinking.supported"];
const REASONING_LEVEL_FIELDS = ["thinking_levels", "thinkingLevels", "effort.supported_levels", "reasoning_effort_support_list"];
const CAPABILITY_LIST_FIELDS = ["supported_parameters", "tags", "features", "supported_features", "metadata.tags"];

function fieldAt(record: Record<string, unknown>, path: string): unknown {
	let value: unknown = record;
	for (const key of path.split(".")) {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

function listAt(record: Record<string, unknown>, path: string): string[] {
	const value = fieldAt(record, path);
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase());
}

function declaredLimit(record: Record<string, unknown>, paths: readonly string[]): number | undefined {
	let limit: number | undefined;
	for (const path of paths) {
		const value = fieldAt(record, path);
		if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
			limit = Math.min(limit ?? value, value);
		}
	}
	return limit;
}

function declaresImageInput(record: Record<string, unknown>): boolean {
	return (
		INPUT_MODALITY_FIELDS.some((path) => listAt(record, path).some((item) => item === "image" || item === "image_url" || item.endsWith("/image")))
		|| IMAGE_FLAG_FIELDS.some((path) => fieldAt(record, path) === true)
		|| CAPABILITY_LIST_FIELDS.some((path) => listAt(record, path).includes("vision"))
	);
}

function declaredThinkingLevels(record: Record<string, unknown>): ThinkingLevel[] {
	for (const path of REASONING_LEVEL_FIELDS) {
		const declared = listAt(record, path).filter((level): level is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(level));
		if (declared.length) return THINKING_LEVELS.filter((level) => declared.includes(level));
	}
	const reasoning = REASONING_FLAG_FIELDS.some((path) => fieldAt(record, path) === true)
		|| CAPABILITY_LIST_FIELDS.some((path) => listAt(record, path).some((item) => item.includes("reasoning")));
	return reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
}

function parsedModelConfig(entry: Record<string, unknown>): ModelConfig | undefined {
	const id = (typeof entry.id === "string" ? entry.id.trim() : "") || (typeof entry.slug === "string" ? entry.slug.trim() : "");
	if (!id) return undefined;
	const contextWindow = declaredLimit(entry, CONTEXT_WINDOW_FIELDS) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = declaredLimit(entry, MAX_TOKENS_FIELDS) ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow);
	const displayName = typeof entry.display_name === "string" && entry.display_name.trim()
		? entry.display_name.trim()
		: typeof entry.displayName === "string" && entry.displayName.trim()
			? entry.displayName.trim()
			: typeof entry.name === "string" && entry.name.trim()
				? entry.name.trim()
				: id;
	return {
		id,
		name: displayName,
		contextWindow,
		maxTokens,
		vision: declaresImageInput(entry),
		thinkingLevels: declaredThinkingLevels(entry),
	};
}

function parseCatalogRows(body: unknown): ModelConfig[] | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const container = body as { data?: unknown; models?: unknown };
	const rows = Array.isArray(body) ? body : Array.isArray(container.data) ? container.data : Array.isArray(container.models) ? container.models : undefined;
	if (!rows) return undefined;
	const models: ModelConfig[] = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const parsed = parsedModelConfig(row as Record<string, unknown>);
		if (parsed) models.push(parsed);
	}
	return rows.length > 0 && models.length === 0 ? undefined : models;
}

function discoveryUrl(baseUrl: string, api: ModelApi): string {
	const url = new URL(baseUrl);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = api === "anthropic-messages" && !path.endsWith("/v1") ? `${path}/v1/models` : `${path}/models`;
	return url.href;
}

function buildHeaders(api: ModelApi | undefined, key: string | undefined): Record<string, string> {
	if (api === "anthropic-messages") {
		return { accept: "application/json", "anthropic-version": "2023-06-01", ...(key ? { "x-api-key": key } : {}) };
	}
	return { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
}

function openAIStyleRetry(
	baseUrl: string,
	api: ModelApi,
	key: string | undefined,
	first: { url: string; headers: Record<string, string>; status: number },
): { url: string; headers: Record<string, string> } | undefined {
	if (api !== "anthropic-messages" || ![401, 403, 404].includes(first.status)) return undefined;
	const root = new URL(baseUrl);
	root.pathname = root.pathname.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
	const url = discoveryUrl(root.href.replace(/\/+$/, ""), api);
	const headers = buildHeaders(undefined, key);
	if (url === first.url && headers.authorization === first.headers.authorization) return undefined;
	return { url, headers };
}

function declaresMorePages(body: unknown): boolean {
	return typeof body === "object" && body !== null && "has_more" in body && body.has_more === true;
}

function nextPageCursor(body: unknown): string | undefined {
	if (!declaresMorePages(body)) return undefined;
	const lastId = (body as { last_id?: unknown }).last_id;
	return typeof lastId === "string" && lastId ? lastId : undefined;
}

export interface ProbeProviderModelsOptions {
	readonly baseUrl: string;
	readonly api: ModelApi;
	readonly key?: string;
	readonly signal?: AbortSignal;
}

/**
 * Probe a custom provider endpoint for candidate models without mutating any stored catalog.
 * Errors deliberately omit response bodies, headers and credentials.
 */
export async function probeProviderModels(
	options: ProbeProviderModelsOptions,
	fetcher: typeof fetch = fetch,
): Promise<ProbeModelsResult> {
	const baseUrl = normalizeBaseUrl(options.baseUrl);
	const key = options.key?.trim() || undefined;
	const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

	const getPage = async (url: string, headers: Record<string, string>): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> => {
		let response: Response;
		try {
			response = await fetcher(url, {
				headers, signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
			});
		} catch (error) {
			if (options.signal?.aborted) throw error;
			throw new Error("Model discovery could not reach the provider. Check the URL and extension permission.");
		}
		if (!response.ok) return { ok: false, status: response.status };
		const text = await response.text();
		if (text.length > MAX_DISCOVERY_RESPONSE) throw new Error("The model discovery response is too large.");
		try {
			return { ok: true, body: JSON.parse(text) };
		} catch {
			throw new Error("The provider returned an invalid model list.");
		}
	};

	let url = discoveryUrl(baseUrl, options.api);
	let headers = buildHeaders(options.api, key);
	let page = await getPage(url, headers);
	if (!page.ok) {
		const retry = openAIStyleRetry(baseUrl, options.api, key, { url, headers, status: page.status });
		if (retry) {
			const retried = await getPage(retry.url, retry.headers);
			if (retried.ok) {
				url = retry.url;
				headers = retry.headers;
				page = retried;
			} else {
				throw new Error(`Model discovery failed with HTTP ${retried.status}.`);
			}
		} else {
			throw new Error(`Model discovery failed with HTTP ${page.status}.`);
		}
	}

	const collected = parseCatalogRows(page.body);
	if (!collected) throw new Error("The provider returned an invalid model list.");

	let body = page.body;
	for (
		let pages = 1;
		options.api === "anthropic-messages" && pages < MAX_ANTHROPIC_PAGES && collected.length < MAX_PROBED_MODELS;
		pages++
	) {
		const cursor = nextPageCursor(body);
		if (!cursor) break;
		const nextUrl = new URL(url);
		nextUrl.searchParams.set("after_id", cursor);
		nextUrl.searchParams.set("limit", "1000");
		const next = await getPage(nextUrl.href, headers);
		if (!next.ok) break;
		const more = parseCatalogRows(next.body);
		if (!more) break;
		collected.push(...more);
		if (nextPageCursor(next.body) === cursor) break;
		body = next.body;
	}

	const deduped = new Map<string, ModelConfig>();
	for (const model of collected) {
		if (!deduped.has(model.id)) deduped.set(model.id, model);
	}
	const sorted = [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
	const truncated = sorted.length > MAX_PROBED_MODELS || declaresMorePages(body);
	return { models: sorted.slice(0, MAX_PROBED_MODELS), truncated };
}
