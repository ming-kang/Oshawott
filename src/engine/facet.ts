import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { AgentDoc, configure as configureAgent, InboxDoc, type ConversationId, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Chat, DEFAULT_BUSY_MODE, ProviderSummary, Workspace } from "../contracts/chat.ts";
import type { Principal } from "../contracts/hosts.ts";
import { arr, ChordError, type Context, defineFacet, defineState, obj } from "../lib/chord.ts";
import {
	cleanupAttachments, contentForSend, contentForUpdate, queuedContent, refsOfQueued, requireContentVision,
	rollbackAttachments, safeAttachmentPath, storeAttachments,
} from "./attachments.ts";
import { RequestDoc, TargetDoc, WorkspaceDoc } from "./docs.ts";
import { ChatFiles, type FileBackend, resolvePath, WORKSPACE } from "./files.ts";
import { deleteChatFiles } from "./files-lifecycle.ts";

export interface EngineServices {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly files: FileBackend;
	readonly now: () => number;
	readonly onError: (error: unknown) => void;
}

const ProviderList = obj({ list: arr(ProviderSummary) });
const Providers = defineState("providers", { schema: ProviderList, version: 1, initial: () => ({ list: [] }) });

export function titleOf(text: string): string {
	const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
	const chars = [...line];
	return chars.length > 48 ? `${chars.slice(0, 47).join("")}…` : line;
}

function forbidden(): never {
	throw new ChordError({ code: "forbidden", message: "Only a panel may use the workspace." });
}

async function providerSummaries(services: EngineServices): Promise<ProviderSummary[]> {
	return Promise.all(services.models.getProviders().map(async (provider) => {
		const auth = await services.models.checkAuth(provider.id).catch(() => undefined);
		return {
			id: provider.id,
			name: provider.name ?? provider.id,
			configured: auth !== undefined,
			models: services.models.getModels(provider.id).map((model) => ({ id: model.id, name: model.name ?? model.id, vision: model.input.includes("image") })),
		};
	}));
}

export function panelFacet(services: EngineServices) {
	const { harness } = services;
	const tails = new Map<number, Promise<void>>();
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

	return defineFacet<Principal>((host) => {
		host.serve(Workspace, (_params, principal, self) => {
			if (principal.kind !== "panel") forbidden();
			const workspace = self.follow((observer, ctx) => harness.observeDoc(WorkspaceDoc, observer, ctx));
			const providers = self.state(Providers);
			const refreshProviders = async (ctx: Context) => {
				const list = await providerSummaries(services);
				await providers.change((draft) => {
					draft.list = list;
				}, ctx);
			};
			self.onLive((ctx) => refreshProviders(ctx));
			return {
				variant: "owner",
				members: {
					chats: self.derive([workspace], ([value]) => value.chats),
					defaultModel: self.derive([workspace], ([value]) => value.defaultModel),
					busyMode: self.derive([workspace], ([value]) => value.busyMode ?? DEFAULT_BUSY_MODE),
					providers: self.derive([providers], ([value]) => value.list),
					createChat: async ({ title }, ctx) => {
						const { defaultModel } = await harness.snapshot(WorkspaceDoc, ctx) ?? { defaultModel: null };
						const conversation = await harness.createConversation(
							{ ownership: { kind: "ownerless" }, agent: defaultModel ? { model: defaultModel } : {} },
							ctx,
						);
						await harness.commit(async (tx) => {
							(await tx.doc(WorkspaceDoc)).chats.push({
								id: conversation.id,
								title: title?.trim() ?? "",
								createdAt: services.now(),
							});
						}, ctx);
						return conversation.id;
					},
					deleteChat: async ({ id }, ctx) => {
						await deleteChatFiles(harness, services.files, id, ctx);
						return null;
					},
					setApiKey: async ({ provider, key }, ctx) => {
						await services.credentials.modify(provider, async () => ({ type: "api_key", key: key.trim() }));
						await refreshProviders(ctx);
						return null;
					},
					clearApiKey: async ({ provider }, ctx) => {
						await services.credentials.delete(provider);
						await refreshProviders(ctx);
						return null;
					},
					setDefaultModel: async (model, ctx) => {
						await harness.commit(async (tx) => {
							(await tx.doc(WorkspaceDoc)).defaultModel = model;
						}, ctx);
						return null;
					},
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
						const previous = await harness.snapshot(RequestDoc, conversationId, ctx);
						const known = previous?.requests.find((item) => item.requestId === requestId);
						if (known) return known.submissionId;
						const prepared = await storeAttachments(services.files, id, attachments, services.now, requestId);
						let duplicatePaths: readonly string[] | undefined;
						try {
							const content = contentForSend(text, prepared);
							let submissionId!: SubmissionId;
							await target.commit(async (tx) => {
								// Check on the admission line too: another panel may remove this chat after the lookup above.
								const workspace = await tx.doc(WorkspaceDoc);
								const summary = workspace.chats.find((chat) => chat.id === id);
								if (!summary) throw gone();
								const requests = await tx.doc(RequestDoc, target.id);
								const existing = requests.requests.find((item) => item.requestId === requestId);
								if (existing) {
									submissionId = existing.submissionId;
									duplicatePaths = existing.attachments;
									return;
								}
								const agent = await tx.doc(AgentDoc, target.id);
								requireContentVision(services, agent.model ?? workspace.defaultModel, content);
								submissionId = await target.submit(tx, { type: "input", content, requestId, ...(whenBusy ? { whenBusy } : {}) });
								requests.requests.push({ requestId, submissionId, attachments: prepared.map((item) => item.path) });
								if (tabId !== undefined) (await tx.doc(TargetDoc, target.id)).tabId = tabId;
								if (!summary.title) summary.title = titleOf(text || prepared.map((item) => item.name).join(", "));
							}, ctx);
							if (duplicatePaths) {
								const owned = new Set(duplicatePaths);
								await cleanupAttachments(harness, services.files, id,
									prepared.filter((item) => item.created && !owned.has(item.path)).map((item) => item.path), ctx).catch(services.onError);
							}
							return submissionId;
						} catch (error) {
							if (!duplicatePaths) await rollbackAttachments(services.files, id, prepared);
							throw error;
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
						const before = await queuedContent(harness, conversationId, submissionId, ctx);
						if (before === undefined) return "not_found" as const;
						const beforeRefs = refsOfQueued(before);
						for (const path of removeAttachments) {
							if (!beforeRefs.some((item) => item.path === path)) {
								throw new ChordError({ code: "invalid", reason: "args", message: `Attachment ${path} does not belong to this queued message.` });
							}
						}
						const removed = new Set(removeAttachments);
						const prepared = await storeAttachments(services.files, id, attachments, services.now,
							requestId ?? `edit-${submissionId}`, removeAttachments);
						let result: "updated" | "not_found";
						try {
							result = await target.commit(async (tx) => {
								const inbox = await tx.doc(InboxDoc, target.id);
								const item = inbox.items.find((item) => item.id === submissionId && (item.mode === "steer" || item.mode === "followUp"));
								if (!item) return "not_found" as const;
								const userItem = item as Exclude<typeof item, { mode: "write" }>;
								if (text !== undefined || prepared.length || removed.size) {
									const content = contentForUpdate(userItem.content, text, prepared, removed);
									const agent = await tx.doc(AgentDoc, target.id);
									requireContentVision(services, agent.model ?? (await tx.doc(WorkspaceDoc)).defaultModel, content);
									userItem.content = content as typeof userItem.content;
								}
								if (whenBusy !== undefined) userItem.mode = whenBusy;
								return "updated" as const;
							}, ctx);
						} catch (error) {
							await rollbackAttachments(services.files, id, prepared);
							throw error;
						}
						if (result === "not_found") {
							await rollbackAttachments(services.files, id, prepared);
							return result;
						}
						const added = new Set(prepared.map((item) => item.path));
						await cleanupAttachments(harness, services.files, id, [...removed].filter((path) => !added.has(path)), ctx).catch(services.onError);
						return result;
					}),
					cancelQueued: locked(async ({ id: submissionId }, ctx) => {
						await conversation(ctx);
						const content = await queuedContent(harness, conversationId, submissionId, ctx);
						const result = await harness.abortSubmission(submissionId as SubmissionId, ctx, conversationId);
						if (result === "aborted" && content) {
							await cleanupAttachments(harness, services.files, id, refsOfQueued(content).map((item) => item.path), ctx).catch(services.onError);
						}
						return result;
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
						const inbox = await harness.snapshot(InboxDoc, conversationId, ctx);
						const queued = (inbox?.items ?? []).filter((item) => item.mode === "steer" || item.mode === "followUp");
						await target.abort(ctx);
						// An item may cross a tool boundary while Stop is in flight; only unanswered inputs' files are unreferenced.
						for (const item of queued) {
							const submission = await harness.submission(item.id as SubmissionId, ctx);
							if ((await submission?.status(ctx))?.status === "unanswered") {
								await cleanupAttachments(harness, services.files, id,
									refsOfQueued((item as Exclude<typeof item, { mode: "write" }>).content).map((attachment) => attachment.path), ctx).catch(services.onError);
							}
						}
						return null;
					}),
					configure: locked(async (model, ctx) => {
						const target = await conversation(ctx);
						await target.commit(async (tx) => {
							const inbox = await tx.doc(InboxDoc, target.id);
							for (const item of inbox.items) {
								if (item.mode === "steer" || item.mode === "followUp") requireContentVision(services, model, item.content);
							}
							await configureAgent(tx, target.id, { model });
						}, ctx);
						return null;
					}),
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

