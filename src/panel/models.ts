// Model selection policy shared by the composer and the menu; no DOM or remote calls here.
import type { ModelRef, ProviderSummary } from "../contracts/chat.ts";

export const configuredProviders = (providers: readonly ProviderSummary[]) => providers.filter((provider) => provider.configured);

/** Keep the choice when its provider is connected, otherwise fall back to the first connected model. */
export function shownModel(providers: readonly ProviderSummary[], chosen: ModelRef | undefined): ModelRef | undefined {
	const connected = configuredProviders(providers);
	if (chosen && connected.some((provider) => provider.id === chosen.provider)) return chosen;
	const first = connected.find((provider) => provider.models.length > 0);
	return first ? { provider: first.id, modelId: first.models[0]!.id } : chosen;
}

export const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) => a?.provider === b?.provider && a?.modelId === b?.modelId;

export function modelName(providers: readonly ProviderSummary[], model: ModelRef): string {
	return providers.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.modelId)?.name ?? model.modelId;
}
