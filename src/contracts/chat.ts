import type { ConversationView, ModelRef as DurableModelRef } from "@earendil-works/pi-durable";
import { arr, bool, bytes, int, method, nul, num, obj, oneOf, opt, remote, type Static, str, typed, union, unknown } from "../lib/chord.ts";
import { MAX_ATTACHMENTS, MAX_TEXT_ATTACHMENT_BYTES } from "../lib/attachments.ts";
import { EngineHost } from "./hosts.ts";

/** A whole conversation's images may appear base64-encoded in one conversation-view part. */
export const PANEL_LINK_LIMITS = { part: 256 * 1024 * 1024, decoded: 512 * 1024 * 1024 } as const;

export const ModelRef = obj({ provider: str(), modelId: str() });
export type ModelRef = DurableModelRef;

export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const BusyMode = oneOf("steer", "followUp");
export type BusyMode = Static<typeof BusyMode>;
export const DEFAULT_BUSY_MODE: BusyMode = "steer";
export const QueueUpdateResult = oneOf("updated", "not_found");
export type QueueUpdateResult = Static<typeof QueueUpdateResult>;
export const QueueCancelResult = oneOf("aborted", "already_placed", "settled", "not_found");
export type QueueCancelResult = Static<typeof QueueCancelResult>;

export const ChatFile = obj({ path: str(), size: int(), mtimeMs: num() });

export const AttachmentInput = obj({
	id: str({ min: 1, max: 100 }),
	name: str({ min: 1, max: 500 }),
	mimeType: str({ max: 200 }),
	data: bytes({ max: MAX_TEXT_ATTACHMENT_BYTES }),
});
export type AttachmentInput = Static<typeof AttachmentInput>;
const AttachmentInputs = arr(AttachmentInput, { max: MAX_ATTACHMENTS });

export const ChatSummary = obj({ id: int(), title: str(), createdAt: num() });
export type ChatSummary = Static<typeof ChatSummary>;

export const ProviderSummary = obj({
	id: str(),
	name: str(),
	configured: bool(),
	models: arr(obj({ id: str(), name: str(), vision: bool() })),
});
export type ProviderSummary = Static<typeof ProviderSummary>;

export const Workspace = remote("oshawott.workspace", {
	version: 3,
	params: {},
	hostAddress: () => EngineHost(),
	variants: {
		owner: {
			state: {
				chats: arr(ChatSummary),
				defaultModel: union([ModelRef, nul()]),
				busyMode: BusyMode,
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
				setBusyMode: method(BusyMode),
			},
		},
	},
});

export const Chat = remote("oshawott.chat", {
	version: 3,
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
						whenBusy: opt(BusyMode),
						attachments: opt(AttachmentInputs),
					}),
					int(),
				),
				/** Edit content and/or delivery while queued. Removed attachment paths must belong to that queued message. */
				updateQueued: method(
					obj({
						id: int(), text: opt(str({ max: 1_000_000 })), whenBusy: opt(BusyMode),
						requestId: opt(str({ min: 1, max: 200 })),
						attachments: opt(AttachmentInputs), removeAttachments: opt(arr(str(), { max: MAX_ATTACHMENTS })),
					}),
					QueueUpdateResult,
				),
				cancelQueued: method(obj({ id: int() }), QueueCancelResult),
				/** Continue an idle failed run, placing any inputs its `keep` policy left queued. */
				continueQueued: method(undefined, int()),
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
