import type { ModelRef, ProviderSummary } from "../contracts/chat.ts";

export const configuredProviders = (providers: readonly ProviderSummary[]) => providers.filter((provider) => provider.configured);

export function shownModel(providers: readonly ProviderSummary[], chosen: ModelRef | undefined): ModelRef | undefined {
	const connected = configuredProviders(providers);
	if (chosen && connected.some((provider) => provider.id === chosen.provider)) return chosen;
	const first = connected.find((provider) => provider.models.length > 0);
	return first ? { provider: first.id, modelId: first.models[0]!.id } : chosen;
}

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) => a?.provider === b?.provider && a?.modelId === b?.modelId;

export function supportsVision(providers: readonly ProviderSummary[], model: ModelRef | undefined): boolean {
	if (!model) return false;
	return providers.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.modelId)?.vision ?? false;
}

export function modelName(providers: readonly ProviderSummary[], model: ModelRef): string {
	return providers.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.modelId)?.name ?? model.modelId;
}
