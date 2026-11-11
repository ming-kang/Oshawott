import {
	createProvider, getSupportedThinkingLevels, type Api, type Model, type ModelsStore, type MutableModels,
	type Provider, type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelApi, ModelRef, ProviderProfile, ProviderSummary } from "../contracts/chat.ts";
import { KeyedSerial } from "../lib/serial.ts";
import type { OAuthSetups } from "./oauth.ts";
import { Published } from "./published.ts";
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

/** Whether a cached model was discovered at `profile`'s current endpoint, not before its URL or API changed. */
const discoveredFor = (profile: ProviderProfile, model: Pick<Model<Api>, "provider" | "baseUrl" | "api">) =>
	model.provider === profile.id && model.baseUrl === profile.baseUrl && model.api === profile.api;

function safeDiscoveryError(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (/^Model discovery (could not reach|failed with HTTP \d{3})/.test(message)) return message;
	if (message === "The provider returned an invalid model list." || message === "The model discovery response is too large.") return message;
	return "Model discovery failed. Check the provider configuration and try again.";
}

export type ProviderSnapshot = { list: ProviderSummary[] };

/**
 * Owns custom runtime registrations and non-secret discovery status; Durable owns their persistent profiles. It
 * publishes the one provider list every Panel follows.
 */
export class ProviderManager {
	readonly #models: MutableModels;
	readonly #modelsStore?: ModelsStore;
	readonly #fetch?: typeof fetch;
	readonly #oauth: OAuthSetups;
	readonly #profiles = new Map<string, ProviderProfile>();
	readonly #refreshing = new Set<string>();
	readonly #errors = new Map<string, string>();
	readonly #lines = new KeyedSerial<string>();
	readonly #published = new Published<ProviderSnapshot>({ list: [] });
	#revision = 0;

	readonly observe = this.#published.observe.bind(this.#published);

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
			void this.changed();
		};
	}

	async restore(inputs: readonly ProviderProfile[]): Promise<void> {
		const profiles = inputs.map(normalizeProfile);
		const ids = new Set(profiles.map((profile) => profile.id));
		for (const id of this.#profiles.keys()) if (!ids.has(id)) this.#models.deleteProvider(id);
		this.#profiles.clear();
		for (const profile of profiles) {
			await this.#dropStaleCatalog(profile);
			this.#profiles.set(profile.id, profile);
			this.#models.setProvider(customProvider(profile, this.#fetch));
		}
		await this.#models.refresh({ allowNetwork: false });
		// Not awaited: the Engine must not wait for every provider's auth check before it starts.
		void this.changed();
	}

	/** IDs in the prospective catalog: new manual entries plus raw discovery, never old manual-only entries. */
	async candidateModelIds(profile: ProviderProfile): Promise<Set<string>> {
		const ids = new Set(profile.models.map((model) => model.id));
		const stored = await this.#modelsStore?.read(profile.id);
		if (stored) {
			for (const model of stored.models) if (discoveredFor(profile, model)) ids.add(model.id);
			return ids;
		}
		const previousManual = new Set(this.#profiles.get(profile.id)?.models.map((model) => model.id) ?? []);
		for (const model of this.#models.getModels(profile.id)) {
			if (discoveredFor(profile, model) && !previousManual.has(model.id)) ids.add(model.id);
		}
		return ids;
	}

	async deleteCatalog(id: string): Promise<void> {
		await this.#modelsStore?.delete(id);
	}

	async restoreCatalog(id: string): Promise<void> {
		const profile = this.#profiles.get(id);
		if (profile) await this.#dropStaleCatalog(profile);
		await this.#models.refresh({ providers: [id], allowNetwork: false });
		await this.changed();
	}

	async #dropStaleCatalog(profile: ProviderProfile) {
		const stored = await this.#modelsStore?.read(profile.id);
		if (stored?.models.some((model) => !discoveredFor(profile, model))) await this.#modelsStore?.delete(profile.id);
	}

	async prepareDelete(id: string): Promise<() => void> {
		if (!this.#profiles.has(id)) throw new Error(`Unknown custom provider ${id}.`);
		return () => {
			this.#profiles.delete(id);
			this.#errors.delete(id);
			this.#models.deleteProvider(id);
			void this.changed();
		};
	}

	/** Publishes the list again: after a registration, a discovery step, or a credential the caller changed. */
	async changed(): Promise<void> {
		const revision = ++this.#revision;
		const list = await this.summaries();
		// A slower, older read must not replace a newer one.
		if (revision === this.#revision) this.#published.set({ list });
	}

	close() {
		this.#published.close();
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

	/** Discovers the provider's models; the published list shows the discovery while it runs and its outcome after. */
	refresh(id: string, force = true): Promise<void> {
		return this.#lines.run(id, async () => {
			if (!this.#models.getProvider(id)) throw new Error(`Unknown provider ${id}.`);
			this.#refreshing.add(id);
			void this.changed();
			try {
				const result = await this.#models.refresh({ providers: [id], force });
				const error = result.errors.get(id);
				if (error) this.#errors.set(id, safeDiscoveryError(error));
				else this.#errors.delete(id);
			} finally {
				this.#refreshing.delete(id);
				await this.changed();
			}
		});
	}

	model(ref: ModelRef): Model<Api> | undefined {
		return this.#models.getModel(ref.provider, ref.modelId);
	}
}
