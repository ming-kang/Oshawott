import type { ConversationView, ModelRef as DurableModelRef } from "@earendil-works/pi-durable";
import { arr, bool, bytes, int, method, nul, num, obj, oneOf, opt, remote, type Static, str, typed, union, unknown } from "../lib/chord.ts";
import { EngineHost } from "./hosts.ts";

export const ModelRef = obj({ provider: str(), modelId: str() });
export type ModelRef = DurableModelRef;

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const ChatFile = obj({ path: str(), size: int(), mtimeMs: num() });

export const ChatSummary = obj({ id: int(), title: str(), createdAt: num() });
export type ChatSummary = Static<typeof ChatSummary>;

export const ProviderSummary = obj({
	id: str(),
	name: str(),
	configured: bool(),
	models: arr(obj({ id: str(), name: str() })),
});
export type ProviderSummary = Static<typeof ProviderSummary>;

export const Workspace = remote("oshawott.workspace", {
	version: 1,
	params: {},
	hostAddress: () => EngineHost(),
	variants: {
		owner: {
			state: {
				chats: arr(ChatSummary),
				defaultModel: union([ModelRef, nul()]),
				providers: arr(ProviderSummary),
			},
			methods: {
				/** `title` empty or absent: the chat takes its first message's beginning when it is sent. */
				createChat: method(obj({ title: opt(str()) }), int()),
				/** Removes the chat from the list (stopping its run) and deletes its files; its record stays in storage. */
				deleteChat: method(obj({ id: int() })),
				setApiKey: method(obj({ provider: str(), key: str({ min: 1 }) })),
				clearApiKey: method(obj({ provider: str() })),
				setDefaultModel: method(ModelRef),
			},
		},
	},
});

export const Chat = remote("oshawott.chat", {
	version: 1,
	params: { id: int() },
	hostAddress: () => EngineHost(),
	variants: {
		owner: {
			state: {
				/** Null until Durable produces its first conversation view. */
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
				configure: method(ModelRef),
				/** The chat's files below `/workspace` (what the model wrote or downloaded), by path relative to it. */
				files: method(undefined, arr(ChatFile)),
				readFile: method(obj({ path: str() }), bytes({ max: MAX_FILE_BYTES })),
				removeFile: method(obj({ path: str() })),
			},
		},
	},
});
