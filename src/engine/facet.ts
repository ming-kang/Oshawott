import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { InboxDoc, type ConversationId, type Harness, type SubmissionId, type UserInput } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Chat, DEFAULT_BUSY_MODE, ProviderSummary, Workspace } from "../contracts/chat.ts";
import type { Principal } from "../contracts/hosts.ts";
import { arr, ChordError, type Context, defineFacet, defineState, obj } from "../lib/chord.ts";
import { TargetDoc, WorkspaceDoc } from "./docs.ts";
import { ChatFiles, type FileBackend, resolvePath, WORKSPACE } from "./files.ts";
import { deleteChatFiles } from "./files-lifecycle.ts";

export interface EngineServices {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly files: FileBackend;
	readonly now: () => number;
}

const ProviderList = obj({ list: arr(ProviderSummary) });
const Providers = defineState("providers", { schema: ProviderList, version: 1, initial: () => ({ list: [] }) });

export function titleOf(text: string): string {
	const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
	const chars = [...line];
	return chars.length > 48 ? `${chars.slice(0, 47).join("")}…` : line;
}

/** Keep image and future attachment blocks in place while replacing their editable text with one block. */
function replaceInputText(content: UserInput, text: string): UserInput {
	if (typeof content === "string") return text;
	let inserted = false;
	const blocks: Exclude<UserInput, string> = [];
	for (const block of content) {
		if (block.type !== "text") blocks.push(block);
		else if (!inserted) {
			blocks.push({ ...block, text });
			inserted = true;
		}
	}
	if (!inserted) blocks.unshift({ type: "text", text });
	return blocks;
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
			models: services.models.getModels(provider.id).map((model) => ({ id: model.id, name: model.name ?? model.id })),
		};
	}));
}

export function panelFacet(services: EngineServices) {
	const { harness } = services;

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
			return {
				variant: "owner",
				members: {
					view,
					send: async ({ text, requestId, tabId, whenBusy }, ctx) => {
						if (!text.trim()) throw new ChordError({ code: "invalid", reason: "args", message: "The message cannot be empty." });
						const target = await conversation(ctx);
						let submissionId!: SubmissionId;
						await target.commit(async (tx) => {
							// Check on the admission line too: another panel may remove this chat after the lookup above.
							const summary = (await tx.doc(WorkspaceDoc)).chats.find((chat) => chat.id === id);
							if (!summary) throw gone();
							submissionId = await target.submit(tx, { type: "input", content: text, requestId, ...(whenBusy ? { whenBusy } : {}) });
							if (tabId !== undefined) (await tx.doc(TargetDoc, target.id)).tabId = tabId;
							if (!summary.title) summary.title = titleOf(text);
						}, ctx);
						return submissionId;
					},
					updateQueued: async ({ id: submissionId, text, whenBusy }, ctx) => {
						if (text === undefined && whenBusy === undefined) {
							throw new ChordError({ code: "invalid", reason: "args", message: "Nothing to update." });
						}
						if (text !== undefined && !text.trim()) {
							throw new ChordError({ code: "invalid", reason: "args", message: "The message cannot be empty." });
						}
						const target = await conversation(ctx);
						return target.commit(async (tx) => {
							const inbox = await tx.doc(InboxDoc, target.id);
							const item = inbox.items.find((item) => item.id === submissionId && (item.mode === "steer" || item.mode === "followUp"));
							if (!item) return "not_found" as const;
							const userItem = item as Exclude<typeof item, { mode: "write" }>;
							if (text !== undefined) userItem.content = replaceInputText(userItem.content, text) as typeof userItem.content;
							if (whenBusy !== undefined) userItem.mode = whenBusy;
							return "updated" as const;
						}, ctx);
					},
					cancelQueued: async ({ id: submissionId }, ctx) => {
						await conversation(ctx);
						return harness.abortSubmission(submissionId as SubmissionId, ctx, conversationId);
					},
					continueQueued: async (ctx) => {
						const target = await conversation(ctx);
						const submission = await target.submit({ type: "continue" }, ctx);
						return submission.id;
					},
					abort: async (ctx) => {
						await (await conversation(ctx)).abort(ctx);
						return null;
					},
					configure: async (model, ctx) => {
						await (await conversation(ctx)).configure({ model }, ctx);
						return null;
					},
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

