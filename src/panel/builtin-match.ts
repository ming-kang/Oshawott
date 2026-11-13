import { THINKING_LEVELS, type ModelConfig, type ModelSummary, type ProviderSummary, type ThinkingLevel } from "../contracts/chat.ts";
import { compactTokens } from "./models.ts";

export type MatchTier = "exact" | "normalized" | "fuzzy";

export interface BuiltinCandidate {
	readonly providerId: string;
	readonly providerName: string;
	readonly model: ModelSummary;
	readonly tier: MatchTier;
}

export type BuiltinFieldKey = "name" | "contextWindow" | "maxTokens" | "vision" | "thinkingLevels";

export interface BuiltinFieldChange {
	readonly field: BuiltinFieldKey;
	readonly same: boolean;
	readonly checked: boolean;
	readonly currentText: string;
	readonly referenceText: string;
	apply(target: ModelConfig): void;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MAX_CANDIDATES = 12;

/** First-party providers rank ahead of aggregator catalogs when multiple built-ins share a model. */
const CANONICAL_PROVIDERS = [
	"anthropic", "openai", "google", "deepseek", "xai", "mistral", "groq",
	"kimi-coding", "minimax", "zai", "moonshotai",
];

function providerPriority(providerId: string): number {
	const index = CANONICAL_PROVIDERS.indexOf(providerId);
	return index < 0 ? CANONICAL_PROVIDERS.length : index;
}

function basenameOf(id: string): string {
	return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

export function normalizeModelId(id: string): string {
	return basenameOf(id)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function fuzzyScore(text: string, query: string): number {
	const lower = text.toLowerCase();
	const trimmed = query.toLowerCase().trim();
	if (!trimmed) return 0;
	if (lower.includes(trimmed)) return 3;
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (tokens.length > 1 && tokens.every((token) => lower.includes(token))) return 2;
	let cursor = 0;
	for (const char of trimmed.replace(/\s+/g, "")) {
		cursor = lower.indexOf(char, cursor);
		if (cursor < 0) return 0;
		cursor++;
	}
	return 1;
}

function sortCandidates<T extends BuiltinCandidate>(items: T[]): T[] {
	return items.sort((a, b) =>
		providerPriority(a.providerId) - providerPriority(b.providerId)
		|| a.model.id.localeCompare(b.model.id),
	);
}

/**
 * Search built-in provider models (`providers` with `kind === "builtin"`), grouped by
 * exact ID, normalized ID, then fuzzy match. Empty queries return leading first-party models.
 */
export function matchBuiltinModels(
	providers: readonly ProviderSummary[],
	query: string,
	max = MAX_CANDIDATES,
): BuiltinCandidate[] {
	const builtins = providers.filter((provider) => provider.kind === "builtin");
	const entries: { providerId: string; providerName: string; model: ModelSummary }[] = [];
	for (const provider of builtins) {
		for (const model of provider.models) {
			entries.push({ providerId: provider.id, providerName: provider.name, model });
		}
	}
	const trimmed = query.trim();
	if (!trimmed) {
		return sortCandidates(
			entries
				.filter((entry) => providerPriority(entry.providerId) < CANONICAL_PROVIDERS.length)
				.map((entry) => ({ ...entry, tier: "exact" as const })),
		).slice(0, max);
	}

	const normalizedQuery = normalizeModelId(trimmed);
	const exact: BuiltinCandidate[] = [];
	const normalized: BuiltinCandidate[] = [];
	const fuzzy: { candidate: BuiltinCandidate; score: number }[] = [];

	for (const entry of entries) {
		if (entry.model.id === trimmed || basenameOf(entry.model.id) === trimmed) {
			exact.push({ ...entry, tier: "exact" });
		} else if (normalizedQuery && normalizeModelId(entry.model.id) === normalizedQuery) {
			normalized.push({ ...entry, tier: "normalized" });
		} else {
			const score = fuzzyScore(`${entry.model.id} ${entry.model.name} ${entry.providerId} ${entry.providerName}`, trimmed);
			if (score > 0) fuzzy.push({ candidate: { ...entry, tier: "fuzzy" }, score });
		}
	}

	fuzzy.sort((a, b) =>
		b.score - a.score
		|| providerPriority(a.candidate.providerId) - providerPriority(b.candidate.providerId)
		|| a.candidate.model.id.localeCompare(b.candidate.model.id),
	);

	return [
		...sortCandidates(exact),
		...sortCandidates(normalized),
		...fuzzy.map((item) => item.candidate),
	].slice(0, max);
}

function canonicalLevels(levels: readonly ThinkingLevel[]): ThinkingLevel[] {
	const selected = new Set(levels);
	const ordered = THINKING_LEVELS.filter((level) => selected.has(level));
	return ordered.length ? ordered : ["off"];
}

function formatLevels(levels: readonly ThinkingLevel[], formatLevel: (level: ThinkingLevel) => string): string {
	return canonicalLevels(levels).map(formatLevel).join(", ");
}

export interface DiffFormatters {
	readonly formatBoolean: (value: boolean) => string;
	readonly formatThinkingLevel: (level: ThinkingLevel) => string;
	readonly unsetLabel: string;
}

/**
 * Compute per-field diff previews from `current` to `reference`.
 * Never touches `id`, `api`, `baseUrl`, or credentials.
 * Fields still at fallback defaults are pre-checked; manually customized fields stay unchecked by default.
 */
export function computeBuiltinChanges(
	current: ModelConfig,
	reference: ModelSummary,
	format: DiffFormatters,
): BuiltinFieldChange[] {
	const idTrimmed = current.id.trim();
	const nameTrimmed = current.name.trim();
	const nameSame = nameTrimmed === reference.name;
	const nameDefaultLike = !nameTrimmed || nameTrimmed === idTrimmed;

	const ctxSame = current.contextWindow === reference.contextWindow;
	const ctxDefaultLike = current.contextWindow === DEFAULT_CONTEXT_WINDOW;

	const maxSame = current.maxTokens === reference.maxTokens;
	const maxDefaultLike = current.maxTokens === DEFAULT_MAX_TOKENS
		|| current.maxTokens === Math.min(DEFAULT_MAX_TOKENS, current.contextWindow);

	const visionSame = current.vision === reference.vision;
	const visionDefaultLike = current.vision === false;

	const currentLevels = canonicalLevels(current.thinkingLevels);
	const referenceLevels = canonicalLevels(reference.thinkingLevels);
	const levelsSame = currentLevels.length === referenceLevels.length
		&& currentLevels.every((level, index) => level === referenceLevels[index]);
	const levelsDefaultLike = currentLevels.length === 1 && currentLevels[0] === "off";

	return [
		{
			field: "name",
			same: nameSame,
			checked: !nameSame && nameDefaultLike && reference.name !== reference.id,
			currentText: nameTrimmed || format.unsetLabel,
			referenceText: reference.name,
			apply: (target) => { target.name = reference.name; },
		},
		{
			field: "contextWindow",
			same: ctxSame,
			checked: !ctxSame && ctxDefaultLike,
			currentText: compactTokens(current.contextWindow),
			referenceText: compactTokens(reference.contextWindow),
			apply: (target) => { target.contextWindow = reference.contextWindow; },
		},
		{
			field: "maxTokens",
			same: maxSame,
			checked: !maxSame && maxDefaultLike,
			currentText: compactTokens(current.maxTokens),
			referenceText: compactTokens(reference.maxTokens),
			apply: (target) => { target.maxTokens = reference.maxTokens; },
		},
		{
			field: "vision",
			same: visionSame,
			checked: !visionSame && visionDefaultLike && reference.vision,
			currentText: format.formatBoolean(current.vision),
			referenceText: format.formatBoolean(reference.vision),
			apply: (target) => { target.vision = reference.vision; },
		},
		{
			field: "thinkingLevels",
			same: levelsSame,
			checked: !levelsSame && levelsDefaultLike && referenceLevels.some((level) => level !== "off"),
			currentText: formatLevels(currentLevels, format.formatThinkingLevel),
			referenceText: formatLevels(referenceLevels, format.formatThinkingLevel),
			apply: (target) => { target.thinkingLevels = [...referenceLevels]; },
		},
	];
}
