// What the Engine serves to panels: the workspace and its chats, as Chord objects over Durable.
//
// Every state member follows Durable through `self.follow` (Durable's synchronous observers), so a panel's reference
// is Durable's committed state, sent once and then as deltas: no event bus, no snapshot polling, no second copy.
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { ConversationId, ConversationView, Harness } from "@earendil-works/pi-durable";
import { Chat, Workspace } from "../contracts/chat.ts";
import type { Principal } from "../contracts/hosts.ts";
import { ChordError, type Context, defineFacet, defineState, arr, bool, obj, str } from "../lib/chord.ts";
import { TargetDoc, WorkspaceDoc } from "./docs.ts";

export interface EngineServices {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	/** The Engine's clock (tests pass a fixed one). */
	readonly now: () => number;
}

const ProviderList = obj({
	list: arr(obj({ id: str(), name: str(), configured: bool(), models: arr(obj({ id: str(), name: str() })) })),
});
const Providers = defineState("providers", { schema: ProviderList, version: 1, initial: () => ({ list: [] }) });

function forbidden(): never {
	throw new ChordError({ code: "forbidden", message: "Only a panel may use the workspace." });
}

async function providerSummaries(services: EngineServices) {
	const list = [];
	for (const provider of services.models.getProviders()) {
		const auth = await services.models.checkAuth(provider.id).catch(() => undefined);
		list.push({
			id: provider.id,
			name: provider.name ?? provider.id,
			configured: auth !== undefined && (auth as { configured?: boolean }).configured !== false,
			models: services.models.getModels(provider.id).map((model) => ({ id: model.id, name: model.name ?? model.id })),
		});
	}
	return list;
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
								title: title ?? "New chat",
								createdAt: services.now(),
							});
						}, ctx);
						return conversation.id;
					},
					setApiKey: async ({ provider, key }, ctx) => {
						await services.credentials.modify(provider, async () => ({ type: "api_key", key }));
						await refreshProviders(ctx);
						return null;
					},
					setDefaultModel: async (model, ctx) => {
						await harness.commit(async (tx) => {
							(await tx.doc(WorkspaceDoc)).defaultModel = model;
						}, ctx);
						return null;
					},
				},
			};
		});

		host.serve(Chat, ({ id }, principal, self) => {
			if (principal.kind !== "panel") forbidden();
			const conversationId = id as ConversationId;
			const conversation = async (ctx: Context) => {
				const found = await harness.conversation(conversationId, ctx);
				if (found === undefined) throw new ChordError({ code: "gone", message: `No chat ${id}` });
				return found;
			};
			const view = self.follow((observer, ctx) => harness.observeConversation(conversationId, observer, ctx));
			return {
				variant: "owner",
				members: {
					view,
					send: async ({ text, requestId, tabId, whenBusy }, ctx) => {
						const target = await conversation(ctx);
						await target.commit(async (tx) => {
							await target.submit(tx, { type: "input", content: text, requestId, ...(whenBusy ? { whenBusy } : {}) });
							if (tabId !== undefined) (await tx.doc(TargetDoc, target.id)).tabId = tabId;
						}, ctx);
						return null;
					},
					abort: async (ctx) => {
						await (await conversation(ctx)).abort(ctx);
						return null;
					},
					reset: async (ctx) => {
						await (await conversation(ctx)).reset(undefined, ctx);
						return null;
					},
					configure: async (model, ctx) => {
						await (await conversation(ctx)).configure({ model }, ctx);
						return null;
					},
					entries: async ({ query, limit }, ctx) => {
						const page = await (await conversation(ctx)).entries(query as never, limit, undefined, ctx);
						return page as never;
					},
				},
			};
		});
	});
}

