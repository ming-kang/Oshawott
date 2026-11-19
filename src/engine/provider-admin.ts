import { clampThinkingLevel, getSupportedThinkingLevels, type CredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { ChatConfiguration, ModelApi, ModelRef, ProbeModelsResult, ProviderProfile, ThinkingLevel } from "../contracts/chat.ts";
import { ChordError, type Context } from "../lib/chord.ts";
import { Serial } from "../lib/serial.ts";
import { ProvidersDoc, WorkspaceDoc } from "./docs.ts";
import type { LoginSessions } from "./oauth.ts";
import { normalizeProfile, probeProviderModels } from "./provider-discovery.ts";
import type { ProviderManager } from "./providers.ts";

export interface ProviderAdminServices {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly providers: ProviderManager;
	readonly logins: LoginSessions;
	readonly fetch?: typeof fetch;
	readonly onError: (error: unknown) => void;
}

function invalid(message: string): never {
	throw new ChordError({ code: "invalid", reason: "args", message });
}

/**
 * Changes to providers, their credentials and the models chats point at. Three stores take part (credentials, the
 * Durable profile document, the discovered catalog) and none shares a transaction with another, so every change runs
 * on one line and undoes its earlier steps when a later one fails.
 */
export class ProviderAdmin {
	readonly #services: ProviderAdminServices;
	readonly #line = new Serial();

	constructor(services: ProviderAdminServices) {
		this.#services = services;
	}

	/** Model choices are validated against the catalog, so they share the line with what changes it. */
	serialize<T>(operation: () => Promise<T>): Promise<T> {
		return this.#line.run(operation);
	}

	/** A model the catalog has and a thinking level it supports; an absent level keeps `previous` as far as the model allows. */
	configuration(input: ChatConfiguration, previous: ThinkingLevel = "off"): Required<ChatConfiguration> {
		const model = this.#services.providers.model(input.model);
		if (!model) invalid(`The selected model ${input.model.modelId} is unavailable. Choose another model.`);
		const thinkingLevel = input.thinkingLevel ?? clampThinkingLevel(model, previous);
		if (!getSupportedThinkingLevels(model).includes(thinkingLevel)) invalid(`${model.name} does not support the ${thinkingLevel} thinking level.`);
		return { model: { ...input.model }, thinkingLevel };
	}

	setDefault(input: ChatConfiguration, ctx: Context) {
		const { harness } = this.#services;
		return this.serialize(async () => {
			const workspace = await harness.snapshot(WorkspaceDoc, ctx);
			const configuration = this.configuration(input, workspace?.defaultThinkingLevel ?? "off");
			await harness.commit(async (tx) => {
				const doc = await tx.doc(WorkspaceDoc);
				doc.defaultModel = configuration.model;
				doc.defaultThinkingLevel = configuration.thinkingLevel;
			}, ctx);
		});
	}

	setApiKey(provider: string, key: string) {
		const { models, credentials, logins, providers } = this.#services;
		return this.serialize(async () => {
			if (!models.getProvider(provider)) invalid(`Unknown provider ${provider}.`);
			logins.cancelProvider(provider);
			await credentials.modify(provider, async () => ({ type: "api_key", key: apiKey(key) }));
			await providers.refresh(provider);
		});
	}

	removeCredential(provider: string) {
		const { models, logins, providers } = this.#services;
		return this.serialize(async () => {
			logins.cancelProvider(provider);
			await models.logout(provider);
			await providers.changed();
		});
	}

	refresh(provider: string) {
		return this.serialize(() => this.#services.providers.refresh(provider));
	}

	/** Built-in configured providers that have no catalog yet (a first start, or a discovery that failed while offline). */
	async discoverMissing() {
		const { providers } = this.#services;
		const missing = (await providers.summaries()).filter((provider) => provider.kind === "builtin" && provider.configured && provider.models.length === 0);
		await Promise.all(missing.map((provider) => providers.refresh(provider.id, false)));
	}

	async probeModels(input: { provider?: string; baseUrl: string; api: ModelApi; key?: string }): Promise<ProbeModelsResult> {
		let key = input.key?.trim() || undefined;
		if (!key && input.provider) {
			const stored = await this.#services.credentials.read(input.provider);
			if (stored?.type === "api_key") key = stored.key;
		}
		return probeProviderModels({ baseUrl: input.baseUrl, api: input.api, key }, this.#services.fetch);
	}

	save(input: ProviderProfile, key: string | undefined, ctx: Context) {
		const { harness, credentials, providers, onError } = this.#services;
		return this.serialize(async () => {
			const profile = normalizeProfile(input);
			const activate = await providers.prepare(profile);
			const available = providers.candidateModelIds(profile);
			const previousKey = key === undefined ? undefined : await credentials.read(profile.id);
			if (key !== undefined) {
				const stored = apiKey(key);
				await credentials.modify(profile.id, async () => ({ type: "api_key", key: stored }));
			}
			try {
				await harness.commit(async (tx) => {
					for (const model of await this.#modelsInUse(tx)) {
						if (model.provider === profile.id && !available.has(model.modelId)) {
							invalid(`Model ${model.modelId} is still used by the default model or a chat. Choose another model before removing it.`);
						}
					}
					const doc = await tx.doc(ProvidersDoc);
					doc.custom = [...doc.custom.filter((provider) => provider.id !== profile.id), profile];
				}, ctx);
			} catch (error) {
				if (key !== undefined) {
					if (previousKey) await credentials.modify(profile.id, async () => previousKey);
					else await credentials.delete(profile.id);
				}
				throw error;
			}
			activate();
			await providers.deleteCatalog(profile.id).catch(onError);
			await providers.changed();
		});
	}

	remove(provider: string, ctx: Context) {
		const { harness, credentials, providers, onError } = this.#services;
		return this.serialize(async () => {
			const activate = await providers.prepareDelete(provider);
			const previousKey = await credentials.read(provider);
			await credentials.delete(provider);
			try {
				await harness.commit(async (tx) => {
					if ((await this.#modelsInUse(tx)).some((model) => model.provider === provider)) {
						invalid("This provider is still used by the default model or a chat. Choose another model before deleting it.");
					}
					const doc = await tx.doc(ProvidersDoc);
					doc.custom = doc.custom.filter((item) => item.id !== provider);
				}, ctx);
			} catch (error) {
				if (previousKey) await credentials.modify(provider, async () => previousKey);
				throw error;
			}
			activate();
			await providers.deleteCatalog(provider).catch(onError);
		});
	}

	async #modelsInUse(tx: Tx): Promise<ModelRef[]> {
		const workspace = await tx.doc(WorkspaceDoc);
		const models = workspace.defaultModel ? [workspace.defaultModel] : [];
		for (const chat of workspace.chats) {
			const { model } = await tx.doc(AgentDoc, chat.id as ConversationId);
			if (model) models.push(model);
		}
		return models;
	}
}

function apiKey(key: string): string {
	const trimmed = key.trim();
	if (!trimmed) invalid("The API key cannot be empty.");
	return trimmed;
}
