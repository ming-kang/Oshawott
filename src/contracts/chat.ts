import type { ConversationView, ModelRef as DurableModelRef } from "@earendil-works/pi-durable";
import { arr, bool, bytes, int, method, nul, num, obj, oneOf, opt, remote, type Static, str, typed, union, unknown } from "../lib/chord.ts";
import { MAX_ATTACHMENTS, MAX_TEXT_ATTACHMENT_BYTES } from "../lib/attachments.ts";
import { EngineHost } from "./hosts.ts";

/** A whole conversation's images may appear base64-encoded in one conversation-view part. */
export const PANEL_LINK_LIMITS = { part: 256 * 1024 * 1024, decoded: 512 * 1024 * 1024 } as const;

export const ModelRef = obj({ provider: str(), modelId: str() });
export type ModelRef = DurableModelRef;

export const ModelApi = oneOf("openai-responses", "anthropic-messages", "openai-completions");
export type ModelApi = Static<typeof ModelApi>;
export const ThinkingLevel = oneOf("off", "minimal", "low", "medium", "high", "xhigh", "max");
export type ThinkingLevel = Static<typeof ThinkingLevel>;
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const ModelConfig = obj({
	id: str({ min: 1, max: 500 }),
	name: str({ min: 1, max: 500 }),
	contextWindow: int({ min: 1 }),
	maxTokens: int({ min: 1 }),
	vision: bool(),
	thinkingLevels: arr(ThinkingLevel, { max: THINKING_LEVELS.length }),
});
export type ModelConfig = Static<typeof ModelConfig>;

/** Non-secret custom provider configuration. API keys never belong to this document or the Panel state. */
export const ProviderProfile = obj({
	id: str({ min: 1, max: 100 }),
	name: str({ min: 1, max: 100 }),
	baseUrl: str({ min: 1, max: 2048 }),
	api: ModelApi,
	models: arr(ModelConfig, { max: 512 }),
});
export type ProviderProfile = Static<typeof ProviderProfile>;

export const ModelSummary = obj({
	id: str(), name: str(), vision: bool(), contextWindow: int(), maxTokens: int(), thinkingLevels: arr(ThinkingLevel), manual: bool(),
});
export type ModelSummary = Static<typeof ModelSummary>;

export const ProviderSummary = obj({
	id: str(),
	name: str(),
	kind: oneOf("builtin", "custom"),
	baseUrl: str(),
	api: union([ModelApi, nul()]),
	configured: bool(),
	models: arr(ModelSummary),
	refreshing: bool(),
	discoveryError: union([str(), nul()]),
});
export type ProviderSummary = Static<typeof ProviderSummary>;

export const ChatConfiguration = obj({ model: ModelRef, thinkingLevel: opt(ThinkingLevel) });
export type ChatConfiguration = Static<typeof ChatConfiguration>;

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

export const ChatStatus = oneOf("idle", "running", "waiting", "failed");
export type ChatStatus = Static<typeof ChatStatus>;
export const ChatSummary = obj({ id: int(), title: str(), createdAt: num(), updatedAt: num(), status: ChatStatus });
export type ChatSummary = Static<typeof ChatSummary>;

export const MAX_INSTRUCTIONS_CHARS = 100_000;

export const Workspace = remote("oshawott.workspace", {
	version: 5,
	params: {},
	hostAddress: () => EngineHost(),
	variants: {
		owner: {
			state: {
				chats: arr(ChatSummary),
				defaultModel: union([ModelRef, nul()]),
				defaultThinkingLevel: ThinkingLevel,
				busyMode: BusyMode,
				autoTitle: bool(),
				autoCompaction: bool(),
				autoRetry: bool(),
				instructions: str(),
				providers: arr(ProviderSummary),
			},
			methods: {
				/** `title` empty or absent: the chat takes its first message's beginning when it is sent. */
				createChat: method(obj({ title: opt(str()) }), int()),
				/** Removes the chat from the list (stopping its run) and deletes its files; its record stays in storage. */
				deleteChat: method(obj({ id: int() })),
				/** Empty titles restore the first-message fallback but still count as a manual title decision. */
				renameChat: method(obj({ id: int(), title: str({ max: 500 }) })),
				setAutoTitle: method(bool()),
				setAutoCompaction: method(bool()),
				setAutoRetry: method(bool()),
				/** Blank text restores the built-in instructions; both return the instructions now in effect. */
				setInstructions: method(obj({ instructions: str({ max: MAX_INSTRUCTIONS_CHARS }) }), str()),
				resetInstructions: method(undefined, str()),
				setApiKey: method(obj({ provider: str(), key: str({ min: 1 }) })),
				clearApiKey: method(obj({ provider: str() })),
				saveProvider: method(obj({ profile: ProviderProfile, key: opt(str({ min: 1 })) })),
				deleteProvider: method(obj({ provider: str() })),
				refreshProvider: method(obj({ provider: str() })),
				setDefaultModel: method(ModelRef),
				setDefaultConfiguration: method(ChatConfiguration),
				setBusyMode: method(BusyMode),
			},
		},
	},
});

export const Chat = remote("oshawott.chat", {
	version: 5,
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
				/** Cancel the old run and its queued inputs, then start a new context without deleting this chat's files. */
				reset: method(),
				configure: method(ChatConfiguration),
				/** The chat's files below `/workspace` (what the model wrote or downloaded), by path relative to it. */
				files: method(undefined, arr(ChatFile)),
				readFile: method(obj({ path: str() }), bytes({ max: MAX_FILE_BYTES })),
				removeFile: method(obj({ path: str() })),
			},
		},
	},
});
