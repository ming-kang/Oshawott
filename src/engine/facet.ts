import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { AgentDoc, configure as configureAgent, InboxDoc, type ConversationId, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Chat, DEFAULT_BUSY_MODE, ProviderSummary, Workspace } from "../contracts/chat.ts";
import type { Principal } from "../contracts/hosts.ts";
import { arr, ChordError, type Context, defineFacet, defineState, obj } from "../lib/chord.ts";
import {
	attachmentPaths, completeAttachmentDeletes, inputForSend, inputForUpdate, intendAttachmentDeletes, type QueuedInput,
	requireContentVision, rollbackAttachments, safeAttachmentPath, storeAttachments,
} from "./attachments.ts";
import { TargetDoc, WorkspaceDoc } from "./docs.ts";
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

	/** Deletion completes after the commit that recorded it; a failure leaves the intent for the next Engine. */
	const completeDeletes = (context: Context) =>
		completeAttachmentDeletes(harness, services.files, context, services.onError).catch(services.onError);

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
						const conversation = await harness.createConversation({
							ownership: { kind: "ownerless" },
							agent: defaultModel ? { model: defaultModel } : {},
							// Registered in the creating commit: no conversation exists without its Workspace entry.
							init: async (tx, conversationId) => {
								(await tx.doc(WorkspaceDoc)).chats.push({ id: conversationId, title: title?.trim() ?? "", createdAt: services.now() });
							},
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
						// Durable's request index makes a retried send land once; a known request stores nothing again.
						const known = await harness.commit((tx) => tx.submissionByRequest(target.id, requestId), ctx);
						if (known) return known.id;
						const prepared = await storeAttachments(services.files, id, attachments, services.now, requestId);
						let admitted = false;
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
								if (!summary.title) summary.title = titleOf(text || prepared.map((item) => item.name).join(", "));
								return submitted;
							}, ctx);
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
						// Withdraw the queued inputs first, with their files' deletion, in one commit (as `Conversation.abort` would).
						// An input placed before it is in the transcript, however its run ends, and keeps its files.
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
							await intendAttachmentDeletes(tx, id, paths);
						}, ctx);
						await target.abort(ctx);
						await completeDeletes(ctx);
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

