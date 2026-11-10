import {
	createProvider, getSupportedThinkingLevels, type Api, type Model, type ModelsStore, type MutableModels,
	type Provider, type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelApi, ModelRef, ProviderProfile, ProviderSummary } from "../contracts/chat.ts";
import type { OAuthSetups } from "./oauth.ts";
import { discoverModels, modelFromConfig, normalizeProfile } from "./provider-discovery.ts";

export interface ProviderManagerOptions {
	readonly models: MutableModels;
	readonly modelsStore?: ModelsStore;
	readonly fetch?: typeof fetch;
	readonly oauth?: OAuthSetups;
}

const APIS: Record<ModelApi, () => ProviderStreams> = {
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
	"openai-completions": openAICompletionsApi,
};

export function customProvider(profile: ProviderProfile, fetcher?: typeof fetch): Provider {
	const base = createProvider({
		id: profile.id,
		name: profile.name,
		baseUrl: profile.baseUrl,
		auth: {
			apiKey: {
				name: `${profile.name} API key`,
				resolve: async ({ credential }) => credential?.key
					? { auth: { apiKey: credential.key }, source: "stored credential" }
					: undefined,
			},
		},
		models: profile.models.map((model) => modelFromConfig(model, profile)),
		fetchModels: (context) => discoverModels(profile, context, fetcher),
		api: APIS[profile.api](),
	});
	const withManualOverrides = (models: readonly Model<Api>[]): Model<Api>[] => {
		const merged = [...models];
		for (const config of profile.models) {
			const override = modelFromConfig(config, profile);
			const index = merged.findIndex((model) => model.id === config.id);
			if (index < 0) merged.push(override);
			else merged[index] = { ...merged[index]!, ...override };
		}
		return merged;
	};
	return {
		...base,
		getModels: () => withManualOverrides(base.getModels()),
		getAllModels: () => withManualOverrides((base.getAllModels?.() ?? base.getModels()) as Model<Api>[]),
	};
}

function safeDiscoveryError(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/^Model discovery (could not reach|failed with HTTP \d{3})/.test(message)) return message;
	if (message === "The provider returned an invalid model list." || message === "The model discovery response is too large.") return message;
	return "Model discovery failed. Check the provider configuration and try again.";
}

/** Owns custom runtime registrations and non-secret discovery status; Durable owns their persistent profiles. */
export class ProviderManager {
	readonly #models: MutableModels;
	readonly #modelsStore?: ModelsStore;
	readonly #fetch?: typeof fetch;
	readonly #oauth: OAuthSetups;
	readonly #profiles = new Map<string, ProviderProfile>();
	readonly #refreshing = new Set<string>();
	readonly #errors = new Map<string, string>();
	readonly #lines = new Map<string, Promise<unknown>>();

	constructor(options: ProviderManagerOptions) {
		this.#models = options.models;
		this.#modelsStore = options.modelsStore;
		this.#fetch = options.fetch;
		this.#oauth = options.oauth ?? {};
	}

	profile(id: string): ProviderProfile | undefined {
		return this.#profiles.get(id);
	}

	/** Build without I/O or other side effects. Validation and the durable commit finish before activation. */
	async prepare(profileInput: ProviderProfile): Promise<() => void> {
		const profile = normalizeProfile(profileInput);
		const previous = this.#profiles.get(profile.id);
		if (!previous && this.#models.getProvider(profile.id)) throw new Error(`Provider ID ${profile.id} is already in use.`);
		const provider = customProvider(profile, this.#fetch);
		return () => {
			this.#profiles.set(profile.id, profile);
			this.#errors.delete(profile.id);
			this.#models.setProvider(provider);
		};
	}

	async restore(inputs: readonly ProviderProfile[]): Promise<void> {
		const profiles = inputs.map(normalizeProfile);
		const ids = new Set(profiles.map((profile) => profile.id));
		for (const id of this.#profiles.keys()) if (!ids.has(id)) this.#models.deleteProvider(id);
		this.#profiles.clear();
		for (const profile of profiles) {
			if (this.#modelsStore) {
				const stored = await this.#modelsStore.read(profile.id);
				if (stored?.models.some((model) => model.provider !== profile.id || model.baseUrl !== profile.baseUrl || model.api !== profile.api)) {
					await this.#modelsStore.delete(profile.id);
				}
			}
			this.#profiles.set(profile.id, profile);
			this.#models.setProvider(customProvider(profile, this.#fetch));
		}
		await this.#models.refresh({ allowNetwork: false });
	}

	/** IDs in the prospective catalog: new manual entries plus raw discovery, never old manual-only entries. */
	async candidateModelIds(profile: ProviderProfile): Promise<Set<string>> {
		const ids = new Set(profile.models.map((model) => model.id));
		const stored = await this.#modelsStore?.read(profile.id);
		if (stored) {
			for (const model of stored.models) {
				if (model.provider === profile.id && model.baseUrl === profile.baseUrl && model.api === profile.api) ids.add(model.id);
			}
			return ids;
		}
		const previousManual = new Set(this.#profiles.get(profile.id)?.models.map((model) => model.id) ?? []);
		for (const model of this.#models.getModels(profile.id)) {
			if (model.baseUrl === profile.baseUrl && model.api === profile.api && !previousManual.has(model.id)) ids.add(model.id);
		}
		return ids;
	}

	async deleteCatalog(id: string): Promise<void> {
		await this.#modelsStore?.delete(id);
	}

	async restoreCatalog(id: string): Promise<void> {
		const profile = this.#profiles.get(id);
		const stored = await this.#modelsStore?.read(id);
		if (profile && stored?.models.some((model) => model.provider !== id || model.baseUrl !== profile.baseUrl || model.api !== profile.api)) {
			await this.#modelsStore?.delete(id);
		}
		await this.#models.refresh({ providers: [id], allowNetwork: false });
	}

	async prepareDelete(id: string): Promise<() => void> {
		if (!this.#profiles.has(id)) throw new Error(`Unknown custom provider ${id}.`);
		return () => {
			this.#profiles.delete(id);
			this.#errors.delete(id);
			this.#models.deleteProvider(id);
		};
	}

	async summaries(): Promise<ProviderSummary[]> {
		return Promise.all(this.#models.getProviders().map(async (provider) => {
			const auth = await this.#models.checkAuth(provider.id).catch(() => undefined);
			const profile = this.#profiles.get(provider.id);
			const { apiKey, oauth } = provider.auth;
			// A signed-in account may be entitled to only part of the catalog (GitHub Copilot).
			const models = auth && provider.filterModels
				? await this.#models.getAvailable(provider.id).catch(() => this.#models.getModels(provider.id))
				: this.#models.getModels(provider.id);
			return {
				id: provider.id,
				name: provider.name ?? provider.id,
				kind: profile ? "custom" as const : "builtin" as const,
				baseUrl: provider.baseUrl ?? "",
				api: profile?.api ?? null,
				configured: auth !== undefined,
				auth: auth?.type ?? null,
				apiKey: apiKey !== undefined,
				oauth: oauth ? { label: oauth.loginLabel ?? oauth.name, origins: [...(this.#oauth[provider.id]?.origins ?? [])] } : null,
				models: models.map((model: Model<Api>) => ({
					id: model.id,
					name: model.name ?? model.id,
					vision: model.input.includes("image"),
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					thinkingLevels: getSupportedThinkingLevels(model),
					manual: profile?.models.some((item) => item.id === model.id) ?? false,
				})),
				refreshing: this.#refreshing.has(provider.id),
				discoveryError: this.#errors.get(provider.id) ?? null,
			};
		}));
	}

	async refresh(id: string, force = true): Promise<void> {
		const previous = this.#lines.get(id) ?? Promise.resolve();
		const run = previous.catch(() => {}).then(async () => {
			if (!this.#models.getProvider(id)) throw new Error(`Unknown provider ${id}.`);
			this.#refreshing.add(id);
			try {
				const result = await this.#models.refresh({ providers: [id], force });
				const error = result.errors.get(id);
				if (error) this.#errors.set(id, safeDiscoveryError(error));
				else this.#errors.delete(id);
			} finally {
				this.#refreshing.delete(id);
			}
		});
		this.#lines.set(id, run);
		try {
			await run;
		} finally {
			if (this.#lines.get(id) === run) this.#lines.delete(id);
		}
	}

	model(ref: ModelRef): Model<Api> | undefined {
		return this.#models.getModel(ref.provider, ref.modelId);
	}
}
