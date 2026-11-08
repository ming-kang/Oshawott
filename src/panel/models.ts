import { THINKING_LEVELS, type ModelRef, type ModelSummary, type ProviderSummary, type ThinkingLevel } from "../contracts/chat.ts";

export const configuredProviders = (providers: readonly ProviderSummary[]) => providers.filter((provider) => provider.configured);

export function shownModel(providers: readonly ProviderSummary[], chosen: ModelRef | undefined): ModelRef | undefined {
	const connected = configuredProviders(providers);
	if (chosen && connected.some((provider) => provider.id === chosen.provider)) return chosen;
	const first = connected.find((provider) => provider.models.length > 0);
	return first ? { provider: first.id, modelId: first.models[0]!.id } : chosen;
}

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) => a?.provider === b?.provider && a?.modelId === b?.modelId;

export function findModel(providers: readonly ProviderSummary[], model: ModelRef | undefined): ModelSummary | undefined {
	if (!model) return undefined;
	return providers.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.modelId);
}

export function supportsVision(providers: readonly ProviderSummary[], model: ModelRef | undefined): boolean {
	return findModel(providers, model)?.vision ?? false;
}

export function supportedThinkingLevels(providers: readonly ProviderSummary[], model: ModelRef | undefined): ThinkingLevel[] {
	return findModel(providers, model)?.thinkingLevels ?? ["off"];
}

/** Match Pi-AI's clamp order so the displayed fallback is also what the next request uses. */
export function clampThinking(levels: readonly ThinkingLevel[], requested: ThinkingLevel): ThinkingLevel {
	if (levels.includes(requested)) return requested;
	const at = THINKING_LEVELS.indexOf(requested);
	for (let index = Math.max(0, at); index < THINKING_LEVELS.length; index++) {
		const candidate = THINKING_LEVELS[index]!;
		if (levels.includes(candidate)) return candidate;
	}
	for (let index = at - 1; index >= 0; index--) {
		const candidate = THINKING_LEVELS[index]!;
		if (levels.includes(candidate)) return candidate;
	}
	return levels[0] ?? "off";
}

export function modelName(providers: readonly ProviderSummary[], model: ModelRef): string {
	return findModel(providers, model)?.name ?? model.modelId;
}

export function compactTokens(value: number): string {
	if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
	return String(value);
}
