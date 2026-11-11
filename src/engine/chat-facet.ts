import { AgentDoc, configure as configureAgent, InboxDoc, type Conversation, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Chat } from "../contracts/chat.ts";
import type { Principal } from "../contracts/hosts.ts";
import { ChordError, type Context, type FacetHost } from "../lib/chord.ts";
import {
	attachmentPaths, completeAttachmentDeletes, inputForSend, inputForUpdate, intendAttachmentDeletes, type QueuedInput,
	requireContentVision, rollbackAttachments, safeAttachmentPath, storeAttachments,
} from "./attachments.ts";
import { TargetDoc, WorkspaceDoc } from "./docs.ts";
import { type FacetServices, forbidden, gone } from "./facet.ts";
import { ChatFiles, resolvePath, WORKSPACE } from "./files.ts";
import { titleOf } from "./titles.ts";

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

export function serveChat(host: FacetHost<Principal>, services: FacetServices) {
	const { harness, admin } = services;
	/** Deletion completes after the commit that recorded it; a failure leaves the intent for the next Engine. */
	const completeDeletes = (context: Context) =>
		completeAttachmentDeletes(harness, services.files, context, services.onError).catch(services.onError);

	host.serve(Chat, ({ id }, principal, self) => {
		if (principal.kind !== "panel") forbidden();
		const conversationId = id as ConversationId;
		const conversation = async (ctx: Context) => {
			const workspace = await harness.snapshot(WorkspaceDoc, ctx);
			if (!workspace?.chats.some((chat) => chat.id === id)) throw gone(id);
			const found = await harness.conversation(conversationId, ctx);
			if (found === undefined) throw gone(id);
			return found;
		};
		const view = self.follow((observer, ctx) => harness.observeConversation(conversationId, observer, ctx));
		const target = self.follow(async (observer, ctx) => {
			// A chat has no target document before its first send, and only an existing document can be followed.
			await harness.commit(async (tx) => { await tx.doc(TargetDoc, conversationId); }, ctx);
			return harness.observeDoc(TargetDoc, conversationId, observer, ctx);
		});
		const approvals = self.follow((observer) => services.approvals.observe(observer));
		const files = new ChatFiles(services.files, id, services.now);
		const inWorkspace = (path: string) => {
			const resolved = resolvePath(WORKSPACE, path);
			if (!resolved.startsWith(`${WORKSPACE}/`)) throw new ChordError({ code: "forbidden", message: `Not a file of this chat: ${path}` });
			return resolved;
		};
		const locked = <A, R>(operation: (args: A, context: Context) => Promise<R>) => (args: A, ctx: Context) => services.chatLine.run(id, () => operation(args, ctx));
		const lockedCall = <R>(operation: (context: Context) => Promise<R>) => (ctx: Context) => services.chatLine.run(id, () => operation(ctx));
		return {
			variant: "owner",
			members: {
				view,
				target: self.derive([target], ([value]) => value.tabId),
				approvals: self.derive([approvals], ([value]) => value.items.filter((item) => item.chat === id).map(({ chat: _chat, ...item }) => item)),
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
							if (!summary) throw gone(id);
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
				decide: async ({ id: approval, decision }) => {
					services.approvals.decide(approval, decision);
					return null;
				},
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
					services.approvals.forget(id);
					await target.reset(undefined, ctx);
					await harness.commit(async (tx) => {
						const summary = (await tx.doc(WorkspaceDoc)).chats.find((chat) => chat.id === id);
						if (summary) summary.updatedAt = services.now();
					}, ctx);
					await completeDeletes(ctx);
					return null;
				}),
				configure: locked((input, ctx) => admin.serialize(async () => {
					const target = await conversation(ctx);
					await target.commit(async (tx) => {
						const agent = await tx.doc(AgentDoc, target.id);
						const configuration = admin.configuration(input, agent.thinkingLevel ?? "off");
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
}
