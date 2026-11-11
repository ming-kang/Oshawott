import { clampThinkingLevel, getSupportedThinkingLevels, type CredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { ChatConfiguration, ModelRef, ProviderProfile, ThinkingLevel } from "../contracts/chat.ts";
import { ChordError, type Context } from "../lib/chord.ts";
import { Serial } from "../lib/serial.ts";
import { ProvidersDoc, WorkspaceDoc } from "./docs.ts";
import type { LoginSessions } from "./oauth.ts";
import { normalizeProfile } from "./provider-discovery.ts";
import type { ProviderManager } from "./providers.ts";

export interface ProviderAdminServices {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly providers: ProviderManager;
	readonly logins: LoginSessions;
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

	/** Signs out or forgets the key: cancels a pending sign-in and deletes the stored credential. */
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

	/** Configured providers that have no catalog yet (a first start, or a discovery that failed while offline). */
	async discoverMissing() {
		const { providers } = this.#services;
		const missing = (await providers.summaries()).filter((provider) => provider.configured && provider.models.length === 0);
		await Promise.all(missing.map((provider) => providers.refresh(provider.id, false)));
	}

	save(input: ProviderProfile, key: string | undefined, ctx: Context) {
		const { harness, credentials, providers, onError } = this.#services;
		return this.serialize(async () => {
			const profile = normalizeProfile(input);
			const previous = providers.profile(profile.id);
			const catalogChanged = previous !== undefined && (previous.baseUrl !== profile.baseUrl || previous.api !== profile.api);
			const activate = await providers.prepare(profile);
			const available = await providers.candidateModelIds(profile);
			for (const model of await this.#modelsInUse(ctx)) {
				if (model.provider === profile.id && !available.has(model.modelId)) {
					invalid(`Model ${model.modelId} is still used by the default model or a chat. Choose another model before removing it.`);
				}
			}
			const previousKey = key === undefined ? undefined : await credentials.read(profile.id);
			if (key !== undefined) {
				const stored = apiKey(key);
				await credentials.modify(profile.id, async () => ({ type: "api_key", key: stored }));
			}
			const writeProfile = (next: ProviderProfile | undefined) => harness.commit(async (tx) => {
				const doc = await tx.doc(ProvidersDoc);
				doc.custom = [...doc.custom.filter((provider) => provider.id !== profile.id), ...(next ? [next] : [])];
			}, ctx);
			let committed = false;
			try {
				await writeProfile(profile);
				committed = true;
				if (catalogChanged) await providers.deleteCatalog(profile.id);
			} catch (error) {
				if (committed) await writeProfile(previous).catch(onError);
				if (key !== undefined) {
					if (previousKey) await credentials.modify(profile.id, async () => previousKey);
					else await credentials.delete(profile.id);
				}
				throw error;
			}
			activate();
			await providers.restoreCatalog(profile.id);
			if (key !== undefined) await providers.refresh(profile.id);
		});
	}

	remove(provider: string, ctx: Context) {
		const { harness, credentials, providers, onError } = this.#services;
		return this.serialize(async () => {
			if ((await this.#modelsInUse(ctx)).some((model) => model.provider === provider)) {
				invalid("This provider is still used by the default model or a chat. Choose another model before deleting it.");
			}
			const activate = await providers.prepareDelete(provider);
			const previousKey = await credentials.read(provider);
			await credentials.delete(provider);
			try {
				await harness.commit(async (tx) => {
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

	/** Every model a chat or the Workspace default points at. */
	async #modelsInUse(ctx: Context): Promise<ModelRef[]> {
		const { harness } = this.#services;
		const workspace = await harness.snapshot(WorkspaceDoc, ctx);
		const chats = await Promise.all((workspace?.chats ?? []).map(async (chat) => (await harness.snapshot(AgentDoc, chat.id as ConversationId, ctx))?.model));
		return [workspace?.defaultModel, ...chats].filter((model): model is ModelRef => model !== null && model !== undefined);
	}
}

function apiKey(key: string): string {
	const trimmed = key.trim();
	if (!trimmed) invalid("The API key cannot be empty.");
	return trimmed;
}
