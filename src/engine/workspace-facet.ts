import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { DEFAULT_BUSY_MODE, Workspace } from "../contracts/chat.ts";
import type { Principal } from "../contracts/hosts.ts";
import { userInput } from "../lib/attachments.ts";
import { ChordError, type Context, type FacetHost } from "../lib/chord.ts";
import { preference, WorkspaceDoc } from "./docs.ts";
import { type FacetServices, forbidden, gone } from "./facet-services.ts";
import { deleteChatFiles } from "./files-lifecycle.ts";
import { currentInstructions, writeInstructions } from "./instructions.ts";
import { titleOf } from "./titles.ts";

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

export function serveWorkspace(host: FacetHost<Principal>, services: FacetServices) {
	const { harness, admin } = services;
	const invalid = (message: string): never => {
		throw new ChordError({ code: "invalid", reason: "args", message });
	};

	host.serve(Workspace, (_params, principal, self) => {
		if (principal.kind !== "panel") forbidden();
		const workspace = self.follow((observer, ctx) => harness.observeDoc(WorkspaceDoc, observer, ctx));
		const activity = self.follow((observer) => services.activity.observe(observer));
		const providers = self.follow((observer) => services.providers.observe(observer));
		const logins = self.follow((observer) => services.logins.observe(observer));
		self.onLive(() => void admin.discoverMissing().catch(services.onError));
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
				autoTitle: self.derive([workspace], ([value]) => preference(value, "autoTitle")),
				autoCompaction: self.derive([workspace], ([value]) => preference(value, "autoCompaction")),
				autoRetry: self.derive([workspace], ([value]) => preference(value, "autoRetry")),
				confirmActions: self.derive([workspace], ([value]) => preference(value, "confirmActions")),
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
					services.approvals.forget(id);
					await deleteChatFiles(harness, services.files, id, ctx);
					return null;
				},
				renameChat: ({ id, title }, ctx) => services.chatLine.run(id, async () => {
					const next = title.trim();
					const existing = await harness.snapshot(WorkspaceDoc, ctx);
					const summary = existing?.chats.find((chat) => chat.id === id);
					if (!summary) throw gone(id);
					const fallback = next || summary.fallbackTitle !== undefined
						? "" : await firstFallbackTitle(harness, id, ctx);
					await harness.commit(async (tx) => {
						const doc = await tx.doc(WorkspaceDoc);
						const current = doc.chats.find((chat) => chat.id === id);
						if (!current) throw gone(id);
						// An empty manual title shows the fallback; before the first message there is none yet, and the first
						// send fills it in while the title stays manual, so no title is ever generated for it.
						current.title = next || (current.fallbackTitle ?? fallback);
						current.titleSource = "manual";
					}, ctx);
					return null;
				}),
				setPreference: async ({ key, enabled }, ctx) => {
					await harness.commit(async (tx) => { (await tx.doc(WorkspaceDoc))[key] = enabled; }, ctx);
					return null;
				},
				setInstructions: ({ instructions }, ctx) => harness.commit((tx) => writeInstructions(tx, { text: instructions }), ctx),
				resetInstructions: (ctx) => harness.commit((tx) => writeInstructions(tx, { text: undefined }), ctx),
				setApiKey: async ({ provider, key }) => {
					await admin.setApiKey(provider, key);
					return null;
				},
				removeCredential: async ({ provider }) => {
					await admin.removeCredential(provider);
					return null;
				},
				startLogin: async ({ provider }) => {
					try {
						return services.logins.start(provider);
					} catch (error) {
						return invalid((error as Error).message);
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
				saveProvider: async ({ profile, key }, ctx) => {
					await admin.save(profile, key, ctx);
					return null;
				},
				deleteProvider: async ({ provider }, ctx) => {
					await admin.remove(provider, ctx);
					return null;
				},
				refreshProvider: async ({ provider }) => {
					await admin.refresh(provider);
					return null;
				},
				setDefaultConfiguration: async (input, ctx) => {
					await admin.setDefault(input, ctx);
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
}
