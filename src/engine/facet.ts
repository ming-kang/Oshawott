import { clampThinkingLevel, getSupportedThinkingLevels, type CredentialStore, type MutableModels } from "@earendil-works/pi-ai";
import { AgentDoc, configure as configureAgent, InboxDoc, type Conversation, type ConversationId, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Chat, type ChatConfiguration, DEFAULT_BUSY_MODE, type ModelRef, ProviderSummary, type ThinkingLevel, Workspace } from "../contracts/chat.ts";
import type { Principal } from "../contracts/hosts.ts";
import { userInput } from "../lib/attachments.ts";
import { arr, ChordError, type Context, defineFacet, defineState, obj } from "../lib/chord.ts";
import {
	attachmentPaths, completeAttachmentDeletes, inputForSend, inputForUpdate, intendAttachmentDeletes, type QueuedInput,
	requireContentVision, rollbackAttachments, safeAttachmentPath, storeAttachments,
} from "./attachments.ts";
import type { ConversationActivity } from "./activity.ts";
import type { LoginSessions } from "./oauth.ts";
import { ProvidersDoc, TargetDoc, WorkspaceDoc } from "./docs.ts";
import { ChatFiles, type FileBackend, resolvePath, WORKSPACE } from "./files.ts";
import { currentInstructions, writeInstructions } from "./instructions.ts";
import { type ChatTitles, titleOf } from "./titles.ts";
import { deleteChatFiles } from "./files-lifecycle.ts";
import { normalizeProfile } from "./provider-discovery.ts";
import type { ProviderManager } from "./providers.ts";

export interface EngineServices {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly providers: ProviderManager;
	readonly logins: LoginSessions;
	readonly files: FileBackend;
	readonly now: () => number;
	readonly activity: ConversationActivity;
	readonly titles: ChatTitles;
	readonly onError: (error: unknown) => void;
}

const ProviderList = obj({ list: arr(ProviderSummary) });
const Providers = defineState("providers", { schema: ProviderList, version: 3, initial: () => ({ list: [] }) });

export { titleOf } from "./titles.ts";

function forbidden(): never {
	throw new ChordError({ code: "forbidden", message: "Only a panel may use the workspace." });
}

function invalid(message: string): never {
	throw new ChordError({ code: "invalid", reason: "args", message });
}

function validConfiguration(services: EngineServices, input: ChatConfiguration, previous: ThinkingLevel = "off"): Required<ChatConfiguration> {
	const model = services.providers.model(input.model);
	if (!model) invalid(`The selected model ${input.model.modelId} is unavailable. Choose another model.`);
	const supported = getSupportedThinkingLevels(model);
	const thinkingLevel = input.thinkingLevel ?? clampThinkingLevel(model, previous);
	if (!supported.includes(thinkingLevel)) invalid(`${model.name} does not support the ${thinkingLevel} thinking level.`);
	return { model: { ...input.model }, thinkingLevel };
}

async function modelReferences(harness: Harness, ctx: Context): Promise<{ workspaceDefault: ModelRef | null; chats: { id: number; model?: ModelRef }[] }> {
	const workspace = await harness.snapshot(WorkspaceDoc, ctx);
	const chats = await Promise.all((workspace?.chats ?? []).map(async (chat) => {
		const agent = await harness.snapshot(AgentDoc, chat.id as ConversationId, ctx);
		return { id: chat.id, model: agent?.model };
	}));
	return { workspaceDefault: workspace?.defaultModel ?? null, chats };
}

async function firstFallbackTitle(harness: Harness, id: number, ctx: Context): Promise<string> {
	const conversation = await harness.conversation(id as ConversationId, ctx);
	if (!conversation) return "";
	const page = await conversation.entries({ order: "ascending" }, 50, undefined, ctx);
	for (const entry of page.items) {
		const message = entry.model?.find((message) => message.role === "user");
		if (message?.role !== "user") continue;
		const input = userInput(entry, message.content);
		const title = titleOf(input.text || input.attachments.map((item) => item.name).join(", "));
		if (title) return title;
	}
	return "";
}

/** Withdraw inputs and record attachment deletion in the same commit, before abort/reset waits for the old run. */
async function withdrawInputs(target: Conversation, chatId: number, ctx: Context) {
	await target.commit(async (tx) => {
		const inbox = await tx.doc(InboxDoc, target.id);
		const paths: string[] = [];
		for (let index = inbox.items.length - 1; index >= 0; index--) {
			const item = inbox.items[index]!;
			if (item.mode === "write") continue;
			paths.push(...attachmentPaths(item as QueuedInput));
			inbox.items.splice(index, 1);
			tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
		}
		await intendAttachmentDeletes(tx, chatId, paths);
	}, ctx);
}

export function panelFacet(services: EngineServices) {
	const { harness } = services;
	const tails = new Map<number, Promise<void>>();
	let providerTail: Promise<unknown> = Promise.resolve();
	function serializeProviders<T>(operation: () => Promise<T>): Promise<T> {
		const run = providerTail.then(operation, operation);
		providerTail = run.catch(() => {});
		return run;
	}
	/** One Engine owns a profile; serialize attachment admission/editing/cancellation within it. */
	async function serialize<T>(id: number, operation: () => Promise<T>): Promise<T> {
		const previous = tails.get(id) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const tail = previous.then(() => gate);
		tails.set(id, tail);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (tails.get(id) === tail) tails.delete(id);
		}
	}

	/** Deletion completes after the commit that recorded it; a failure leaves the intent for the next Engine. */
	const completeDeletes = (context: Context) =>
		completeAttachmentDeletes(harness, services.files, context, services.onError).catch(services.onError);

	return defineFacet<Principal>((host) => {
		host.serve(Workspace, (_params, principal, self) => {
			if (principal.kind !== "panel") forbidden();
			const workspace = self.follow((observer, ctx) => harness.observeDoc(WorkspaceDoc, observer, ctx));
			const activity = self.follow((observer) => services.activity.observe(observer));
			const providers = self.state(Providers);
			let providerRevision = 0;
			const refreshProviders = async (ctx: Context) => {
				const revision = ++providerRevision;
				const list = await services.providers.summaries();
				if (revision !== providerRevision) return;
				await providers.change((draft) => {
					draft.list = list;
				}, ctx);
			};
			const discover = async (id: string, ctx: Context, force = true) => {
				const pending = services.providers.refresh(id, force);
				await Promise.resolve();
				await refreshProviders(ctx);
				await pending;
				await refreshProviders(ctx);
			};
			const removeCredential = (provider: string, ctx: Context) => serializeProviders(async () => {
				services.logins.cancelProvider(provider);
				await services.models.logout(provider);
				await refreshProviders(ctx);
				return null;
			});
			const logins = self.follow((observer) => services.logins.observe(observer));
			// A finished sign-in changes the provider's auth, and the account decides which models it may use.
			const signedIn = new Set<string>();
			self.on(logins, async ({ value }, ctx) => {
				const fresh = value.items.filter((item) => item.status === "done" && !signedIn.has(item.id));
				for (const item of fresh) signedIn.add(item.id);
				await Promise.all(fresh.map((item) => discover(item.provider, ctx)));
			});
			self.onLive((ctx) => {
				void (async () => {
					await refreshProviders(ctx);
					const configured = (await services.providers.summaries()).filter((provider) => provider.configured && provider.models.length === 0);
					await Promise.all(configured.map((provider) => services.providers.refresh(provider.id, false)));
					if (configured.length) await refreshProviders(ctx);
				})().catch(services.onError);
			});
			return {
				variant: "owner",
				members: {
					chats: self.derive([workspace, activity], ([value, activity]) => value.chats.map((chat) => ({
						id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt ?? chat.createdAt,
						status: activity.items.find((item) => item.id === chat.id)?.status ?? "idle",
					}))),
					defaultModel: self.derive([workspace], ([value]) => value.defaultModel),
					defaultThinkingLevel: self.derive([workspace], ([value]) => value.defaultThinkingLevel ?? "off"),
					busyMode: self.derive([workspace], ([value]) => value.busyMode ?? DEFAULT_BUSY_MODE),
					autoTitle: self.derive([workspace], ([value]) => value.autoTitle ?? false),
					autoCompaction: self.derive([workspace], ([value]) => value.autoCompaction ?? true),
					autoRetry: self.derive([workspace], ([value]) => value.autoRetry ?? true),
					instructions: self.derive([workspace], ([value]) => currentInstructions(value)),
					providers: self.derive([providers], ([value]) => value.list),
					logins: self.derive([logins], ([value]) => value.items),
					createChat: async ({ title }, ctx) => {
						const workspace = await harness.snapshot(WorkspaceDoc, ctx);
						const defaultModel = workspace?.defaultModel ?? null;
						const defaultThinkingLevel = workspace?.defaultThinkingLevel ?? "off";
						const initialTitle = title?.trim() ?? "";
						const createdAt = services.now();
						const conversation = await harness.createConversation({
							ownership: { kind: "ownerless" },
							agent: { ...(defaultModel ? { model: defaultModel } : {}), thinkingLevel: defaultThinkingLevel },
							// Registered in the creating commit: no conversation exists without its Workspace entry.
							init: async (tx, conversationId) => {
								const doc = await tx.doc(WorkspaceDoc);
								doc.chats.push({
									id: conversationId, title: initialTitle, createdAt, updatedAt: createdAt,
									titleSource: initialTitle ? "manual" : "fallback",
								});
								// Read on the creation line: a concurrent global edit cannot leave this new chat with stale instructions.
								await writeInstructions(tx, undefined, conversationId);
							},
						}, ctx);
						return conversation.id;
					},
					deleteChat: async ({ id }, ctx) => {
						await deleteChatFiles(harness, services.files, id, ctx);
						return null;
					},
					renameChat: ({ id, title }, ctx) => serialize(id, async () => {
						const next = title.trim();
						const existing = await harness.snapshot(WorkspaceDoc, ctx);
						const summary = existing?.chats.find((chat) => chat.id === id);
						if (!summary) throw new ChordError({ code: "gone", message: `No chat ${id}` });
						const fallback = next || summary.fallbackTitle !== undefined
							? "" : await firstFallbackTitle(harness, id, ctx);
						await harness.commit(async (tx) => {
							const doc = await tx.doc(WorkspaceDoc);
							const current = doc.chats.find((chat) => chat.id === id);
							if (!current) throw new ChordError({ code: "gone", message: `No chat ${id}` });
							// An empty manual title shows the fallback; before the first message there is none yet, and the first
							// send fills it in while the title stays manual, so no title is ever generated for it.
							current.title = next || (current.fallbackTitle ?? fallback);
							current.titleSource = "manual";
						}, ctx);
						return null;
					}),
					setAutoTitle: async (enabled, ctx) => {
						await harness.commit(async (tx) => { (await tx.doc(WorkspaceDoc)).autoTitle = enabled; }, ctx);
						return null;
					},
					setAutoCompaction: async (enabled, ctx) => {
						await harness.commit(async (tx) => { (await tx.doc(WorkspaceDoc)).autoCompaction = enabled; }, ctx);
						return null;
					},
					setAutoRetry: async (enabled, ctx) => {
						await harness.commit(async (tx) => { (await tx.doc(WorkspaceDoc)).autoRetry = enabled; }, ctx);
						return null;
					},
					setInstructions: async ({ instructions }, ctx) => {
						return await harness.commit((tx) => writeInstructions(tx, { text: instructions }), ctx);
					},
					resetInstructions: async (ctx) => {
						return await harness.commit((tx) => writeInstructions(tx, { text: undefined }), ctx);
					},
					setApiKey: ({ provider, key }, ctx) => serializeProviders(async () => {
						if (!services.models.getProvider(provider)) invalid(`Unknown provider ${provider}.`);
						const trimmed = key.trim();
						if (!trimmed) invalid("The API key cannot be empty.");
						services.logins.cancelProvider(provider);
						await services.credentials.modify(provider, async () => ({ type: "api_key", key: trimmed }));
						await refreshProviders(ctx);
						await discover(provider, ctx);
						return null;
					}),
					clearApiKey: ({ provider }, ctx) => removeCredential(provider, ctx),
					startLogin: async ({ provider }) => {
						try {
							return services.logins.start(provider);
						} catch (error) {
							invalid((error as Error).message);
						}
					},
					answerLogin: async ({ id, promptId, value }) => {
						try {
							services.logins.answer(id, promptId, value);
						} catch (error) {
							invalid((error as Error).message);
						}
						return null;
					},
					cancelLogin: async ({ id }) => {
						services.logins.cancel(id);
						return null;
					},
					dismissLogin: async ({ id }) => {
						services.logins.dismiss(id);
						return null;
					},
					logout: ({ provider }, ctx) => removeCredential(provider, ctx),
					saveProvider: ({ profile: input, key }, ctx) => serializeProviders(async () => {
						const profile = normalizeProfile(input);
						const previousProfile = services.providers.profile(profile.id);
						const catalogChanged = previousProfile !== undefined && (previousProfile.baseUrl !== profile.baseUrl || previousProfile.api !== profile.api);
						const activate = await services.providers.prepare(profile);
						const references = await modelReferences(harness, ctx);
						const available = await services.providers.candidateModelIds(profile);
						for (const model of [references.workspaceDefault, ...references.chats.map((chat) => chat.model)]) {
							if (model?.provider === profile.id && !available.has(model.modelId)) {
								invalid(`Model ${model.modelId} is still used by the default model or a chat. Choose another model before removing it.`);
							}
						}
						const previousKey = key === undefined ? undefined : await services.credentials.read(profile.id);
						if (key !== undefined) {
							const trimmed = key.trim();
							if (!trimmed) invalid("The API key cannot be empty.");
							await services.credentials.modify(profile.id, async () => ({ type: "api_key", key: trimmed }));
						}
						let committed = false;
						try {
							await harness.commit(async (tx) => {
								const doc = await tx.doc(ProvidersDoc);
								const index = doc.custom.findIndex((provider) => provider.id === profile.id);
								if (index < 0) doc.custom.push(profile);
								else doc.custom[index] = profile;
							}, ctx);
							committed = true;
							if (catalogChanged) await services.providers.deleteCatalog(profile.id);
						} catch (error) {
							if (committed) {
								await harness.commit(async (tx) => {
									const doc = await tx.doc(ProvidersDoc);
									const index = doc.custom.findIndex((provider) => provider.id === profile.id);
									if (previousProfile && index >= 0) doc.custom[index] = previousProfile;
									else if (previousProfile) doc.custom.push(previousProfile);
									else doc.custom = doc.custom.filter((provider) => provider.id !== profile.id);
								}, ctx).catch(services.onError);
							}
							if (key !== undefined) {
								if (previousKey) await services.credentials.modify(profile.id, async () => previousKey);
								else await services.credentials.delete(profile.id);
							}
							throw error;
						}
						activate();
						await services.providers.restoreCatalog(profile.id);
						await refreshProviders(ctx);
						if (key !== undefined) await discover(profile.id, ctx);
						return null;
					}),
					deleteProvider: ({ provider }, ctx) => serializeProviders(async () => {
						const references = await modelReferences(harness, ctx);
						if (references.workspaceDefault?.provider === provider || references.chats.some((chat) => chat.model?.provider === provider)) {
							invalid("This provider is still used by the default model or a chat. Choose another model before deleting it.");
						}
						const activate = await services.providers.prepareDelete(provider);
						const previousKey = await services.credentials.read(provider);
						await services.credentials.delete(provider);
						try {
							await harness.commit(async (tx) => {
								const doc = await tx.doc(ProvidersDoc);
								doc.custom = doc.custom.filter((item) => item.id !== provider);
							}, ctx);
						} catch (error) {
							if (previousKey) await services.credentials.modify(provider, async () => previousKey);
							throw error;
						}
						activate();
						await services.providers.deleteCatalog(provider).catch(services.onError);
						await refreshProviders(ctx);
						return null;
					}),
					refreshProvider: ({ provider }, ctx) => serializeProviders(async () => {
						await discover(provider, ctx);
						return null;
					}),
					setDefaultModel: (model, ctx) => serializeProviders(async () => {
						const workspace = await harness.snapshot(WorkspaceDoc, ctx);
						const configuration = validConfiguration(services, { model }, workspace?.defaultThinkingLevel ?? "off");
						await harness.commit(async (tx) => {
							const doc = await tx.doc(WorkspaceDoc);
							doc.defaultModel = configuration.model;
							doc.defaultThinkingLevel = configuration.thinkingLevel;
						}, ctx);
						return null;
					}),
					setDefaultConfiguration: (input, ctx) => serializeProviders(async () => {
						const workspace = await harness.snapshot(WorkspaceDoc, ctx);
						const configuration = validConfiguration(services, input, workspace?.defaultThinkingLevel ?? "off");
						await harness.commit(async (tx) => {
							const doc = await tx.doc(WorkspaceDoc);
							doc.defaultModel = configuration.model;
							doc.defaultThinkingLevel = configuration.thinkingLevel;
						}, ctx);
						return null;
					}),
					setBusyMode: async (mode, ctx) => {
						await harness.commit(async (tx) => {
							(await tx.doc(WorkspaceDoc)).busyMode = mode;
						}, ctx);
						return null;
					},
				},
			};
		});

		host.serve(Chat, ({ id }, principal, self) => {
			if (principal.kind !== "panel") forbidden();
			const conversationId = id as ConversationId;
			const gone = () => new ChordError({ code: "gone", message: `No chat ${id}` });
			const conversation = async (ctx: Context) => {
				const workspace = await harness.snapshot(WorkspaceDoc, ctx);
				if (!workspace?.chats.some((chat) => chat.id === id)) throw gone();
				const found = await harness.conversation(conversationId, ctx);
				if (found === undefined) throw new ChordError({ code: "gone", message: `No chat ${id}` });
				return found;
			};
			const view = self.follow((observer, ctx) => harness.observeConversation(conversationId, observer, ctx));
			const files = new ChatFiles(services.files, id, services.now);
			const inWorkspace = (path: string) => {
				const resolved = resolvePath(WORKSPACE, path);
				if (!resolved.startsWith(`${WORKSPACE}/`)) throw new ChordError({ code: "forbidden", message: `Not a file of this chat: ${path}` });
				return resolved;
			};
			const locked = <A, R>(operation: (args: A, context: Context) => Promise<R>) => (args: A, ctx: Context) => serialize(id, () => operation(args, ctx));
			const lockedCall = <R>(operation: (context: Context) => Promise<R>) => (ctx: Context) => serialize(id, () => operation(ctx));
			return {
				variant: "owner",
				members: {
					view,
					send: locked(async ({ text, requestId, tabId, whenBusy, attachments = [] }, ctx) => {
						if (!text.trim() && !attachments.length) throw new ChordError({ code: "invalid", reason: "args", message: "The message cannot be empty." });
						const target = await conversation(ctx);
						// Durable's request index makes a retried send land once; a known request stores nothing again.
						const known = await harness.commit((tx) => tx.submissionByRequest(target.id, requestId), ctx);
						if (known) return known.id;
						const prepared = await storeAttachments(services.files, id, attachments, services.now, requestId);
						let admitted = false;
						let titleFallback: string | undefined;
						try {
							const input = inputForSend(text, prepared);
							const submissionId = await target.commit(async (tx) => {
								// Check on the admission line too: another panel may remove this chat, or admit this request, meanwhile.
								const existing = await tx.submissionByRequest(target.id, requestId);
								if (existing) return existing.id;
								const workspace = await tx.doc(WorkspaceDoc);
								const summary = workspace.chats.find((chat) => chat.id === id);
								if (!summary) throw gone();
								const agent = await tx.doc(AgentDoc, target.id);
								requireContentVision(services, agent.model ?? workspace.defaultModel, input.content);
								const submitted = await target.submit(tx, { type: "input", ...input, requestId, ...(whenBusy ? { whenBusy } : {}) });
								admitted = true;
								if (tabId !== undefined) (await tx.doc(TargetDoc, target.id)).tabId = tabId;
								summary.updatedAt = services.now();
								const fallback = titleOf(text || prepared.map((item) => item.name).join(", "));
								if (!summary.fallbackTitle && fallback) summary.fallbackTitle = fallback;
								// Older documents have no source: an empty title still follows the first message.
								const source = summary.titleSource ?? (summary.title ? undefined : "fallback");
								if (!summary.title) {
									summary.title = summary.fallbackTitle ?? fallback;
									if (source) summary.titleSource = source;
								}
								// The first input is the only title opportunity; it is stored, so a restart or retry never repeats it.
								if (!summary.titleInitialized) {
									summary.titleInitialized = true;
									if (workspace.autoTitle && source === "fallback" && summary.title) titleFallback = summary.title;
								}
								return submitted;
							}, ctx);
							if (titleFallback !== undefined) services.titles.schedule(id, submissionId, titleFallback);
							return submissionId;
						} finally {
							// Files this attempt created belong to no input unless it was admitted: an earlier admission of the
							// same request already had its own files, which this attempt found in place (`created: false`).
							if (!admitted) await rollbackAttachments(services.files, id, prepared);
						}
					}),
					updateQueued: locked(async ({ id: submissionId, text, whenBusy, requestId, attachments = [], removeAttachments = [] }, ctx) => {
						if (text === undefined && whenBusy === undefined && !attachments.length && !removeAttachments.length) {
							throw new ChordError({ code: "invalid", reason: "args", message: "Nothing to update." });
						}
						if (attachments.length && !requestId) {
							throw new ChordError({ code: "invalid", reason: "args", message: "Attachment edits need a request ID." });
						}
						for (const path of removeAttachments) safeAttachmentPath(path);
						const target = await conversation(ctx);
						const removed = new Set(removeAttachments);
						const prepared = await storeAttachments(services.files, id, attachments, services.now,
							requestId ?? `edit-${submissionId}`, removeAttachments);
						let result: "updated" | "not_found" = "not_found";
						try {
							result = await target.commit(async (tx) => {
								const inbox = await tx.doc(InboxDoc, target.id);
								const item = inbox.items.find((item) => item.id === submissionId && (item.mode === "steer" || item.mode === "followUp"));
								if (!item || item.mode === "write") return "not_found" as const;
								if (text !== undefined || prepared.length || removed.size) {
									const next = inputForUpdate(item as QueuedInput, text, prepared, removed);
									const agent = await tx.doc(AgentDoc, target.id);
									requireContentVision(services, agent.model ?? (await tx.doc(WorkspaceDoc)).defaultModel, next.content);
									item.content = next.content as typeof item.content;
									if (next.entry) item.entry = next.entry as typeof item.entry;
									else delete item.entry;
									const added = new Set(prepared.map((attachment) => attachment.path));
									await intendAttachmentDeletes(tx, id, [...removed].filter((path) => !added.has(path)));
								}
								if (whenBusy !== undefined) item.mode = whenBusy;
								return "updated" as const;
							}, ctx);
						} finally {
							if (result !== "updated") await rollbackAttachments(services.files, id, prepared);
						}
						await completeDeletes(ctx);
						return result;
					}),
					cancelQueued: locked(async ({ id: submissionId }, ctx) => {
						const target = await conversation(ctx);
						// Withdraw as `abortSubmission` does, recording the input's files for deletion in the same commit. An input
						// still in the inbox is queued: placement removes it there in the commit that places it.
						const withdrawn = await target.commit(async (tx) => {
							const inbox = await tx.doc(InboxDoc, target.id);
							const index = inbox.items.findIndex((item) => item.id === submissionId);
							const item = inbox.items[index];
							if (!item || item.mode === "write") return false;
							await intendAttachmentDeletes(tx, id, attachmentPaths(item as QueuedInput));
							inbox.items.splice(index, 1);
							tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
							return true;
						}, ctx);
						if (!withdrawn) return await harness.abortSubmission(submissionId as SubmissionId, ctx, conversationId);
						await completeDeletes(ctx);
						return "aborted" as const;
					}),
					continueQueued: lockedCall(async (ctx) => {
						const target = await conversation(ctx);
						const [inbox, agent, workspace] = await Promise.all([
							harness.snapshot(InboxDoc, conversationId, ctx), harness.snapshot(AgentDoc, conversationId, ctx), harness.snapshot(WorkspaceDoc, ctx),
						]);
						for (const item of inbox?.items ?? []) {
							if (item.mode === "steer" || item.mode === "followUp") requireContentVision(services, agent?.model ?? workspace?.defaultModel, item.content);
						}
						const submission = await target.submit({ type: "continue" }, ctx);
						return submission.id;
					}),
					abort: lockedCall(async (ctx) => {
						const target = await conversation(ctx);
						// An input placed before withdrawal is in the transcript and keeps its files.
						await withdrawInputs(target, id, ctx);
						await target.abort(ctx);
						await completeDeletes(ctx);
						return null;
					}),
					reset: lockedCall(async (ctx) => {
						const target = await conversation(ctx);
						// Do not let inputs admitted for the old context trigger model calls after the reset.
						await withdrawInputs(target, id, ctx);
						await target.abort(ctx);
						await target.reset(undefined, ctx);
						await harness.commit(async (tx) => {
							const summary = (await tx.doc(WorkspaceDoc)).chats.find((chat) => chat.id === id);
							if (summary) summary.updatedAt = services.now();
						}, ctx);
						await completeDeletes(ctx);
						return null;
					}),
					configure: locked((input, ctx) => serializeProviders(async () => {
						const target = await conversation(ctx);
						await target.commit(async (tx) => {
							const agent = await tx.doc(AgentDoc, target.id);
							const configuration = validConfiguration(services, input, agent.thinkingLevel ?? "off");
							const inbox = await tx.doc(InboxDoc, target.id);
							for (const item of inbox.items) {
								if (item.mode === "steer" || item.mode === "followUp") requireContentVision(services, configuration.model, item.content);
							}
							await configureAgent(tx, target.id, configuration);
						}, ctx);
						return null;
					})),
					files: async (ctx) => {
						await conversation(ctx);
						return [...getOrThrow(await files.workspaceFiles(ctx))];
					},
					readFile: async ({ path }, ctx) => {
						await conversation(ctx);
						return getOrThrow(await files.readBinaryFile(inWorkspace(path), ctx));
					},
					removeFile: async ({ path }, ctx) => {
						await conversation(ctx);
						getOrThrow(await files.remove(inWorkspace(path), undefined, ctx));
						return null;
					},
				},
			};
		});
	});
}

