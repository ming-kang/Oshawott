// What a panel uses: the workspace (chats, models, keys) and one chat. Served by the Engine.
//
// A chat's state is Durable's conversation view itself (`Conversation.watch`'s value: a window of entries plus the
// documents, `pi.live` streaming included). The panel renders it with `ConversationTranscript`, and `entries` pages in
// what lies before the window. Nothing is mirrored into a second store, and nothing is broadcast per event.
import type { ConversationView } from "@earendil-works/pi-durable";
import { arr, bool, int, method, num, obj, oneOf, opt, remote, str, typed, unknown } from "../lib/chord.ts";
import { EngineHost } from "./hosts.ts";

const ModelRef = obj({ provider: str(), modelId: str() });

export const ChatSummary = obj({ id: int(), title: str(), createdAt: num() });

export const ProviderSummary = obj({
	id: str(),
	name: str(),
	configured: bool(),
	models: arr(obj({ id: str(), name: str() })),
});

export const Workspace = remote("oshawatt.workspace", {
	version: 1,
	params: {},
	hostAddress: () => EngineHost(),
	variants: {
		owner: {
			state: {
				chats: arr(ChatSummary),
				defaultModel: typed<{ provider: string; modelId: string } | null>(unknown()),
				providers: arr(ProviderSummary),
			},
			methods: {
				createChat: method(obj({ title: opt(str()) }), int()),
				setApiKey: method(obj({ provider: str(), key: str() })),
				setDefaultModel: method(ModelRef),
			},
		},
	},
});

export const Chat = remote("oshawatt.chat", {
	version: 1,
	/** Durable's conversation id. */
	params: { id: int() },
	hostAddress: () => EngineHost(),
	variants: {
		owner: {
			state: {
				/** Durable's view of the conversation; null until its first value. */
				view: typed<ConversationView | null>(unknown()),
			},
			methods: {
				/**
				 * Admits the user's text. `requestId` makes a retried send land once; `tabId` is the tab the panel shows,
				 * the page tools' default target from now on; `whenBusy` steers the running run or queues a follow-up.
				 */
				send: method(
					obj({
						text: str({ max: 1_000_000 }),
						requestId: str({ min: 1, max: 200 }),
						tabId: opt(int()),
						whenBusy: opt(oneOf("steer", "followUp")),
					}),
				),
				abort: method(),
				reset: method(),
				configure: method(ModelRef),
				/** Older entries than the view's window, for `ConversationTranscript`. */
				entries: method(obj({ query: unknown(), limit: int({ min: 1, max: 200 }) }), unknown()),
			},
		},
	},
});
