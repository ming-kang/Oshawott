import { defineDoc } from "@earendil-works/pi-durable";
import { DEFAULT_BUSY_MODE, type BusyMode, type ModelRef, type ProviderProfile, type ThinkingLevel } from "../contracts/chat.ts";

/** `fallback` follows the first message; `manual` and `auto` are never replaced by a generated title. */
export type TitleSource = "fallback" | "manual" | "auto";
/** Internal list metadata; runtime status is derived from Durable rather than stored here. */
export type WorkspaceChat = {
	id: number;
	title: string;
	createdAt: number;
	/** Last user-visible activity: a send, a reset, or a finished run. Absent in older documents: `createdAt`. */
	updatedAt?: number;
	fallbackTitle?: string;
	/** Absent in older documents: an empty title then behaves as `fallback`, any other title as decided. */
	titleSource?: TitleSource;
	/** Set by the first admitted input, the single opportunity for an automatic title. */
	titleInitialized?: boolean;
};

export type WorkspaceState = {
	chats: WorkspaceChat[];
	defaultModel: ModelRef | null;
	/** Absent in older documents, whose thinking preference is Off. */
	defaultThinkingLevel?: ThinkingLevel;
	/** Absent in older documents, whose delivery preference is Steer. */
	busyMode?: BusyMode;
	/** Optional in older documents. Automatic titles are opt-in; the other policies retain Durable's defaults. */
	autoTitle?: boolean;
	autoCompaction?: boolean;
	autoRetry?: boolean;
	/** Ask before each action that changes a page. Absent in older documents: off. */
	confirmActions?: boolean;
	/** Global native Durable instructions, shared by every chat; absent means the built-in text. */
	instructions?: string;
	/** Optional for older v1 documents. An intent survives eviction between removing a chat and clearing its files. */
	pendingFileDeletes?: number[];
};

export const WorkspaceDoc = defineDoc<WorkspaceState>({
	kind: "oshawott.workspace",
	version: 1,
	scope: "session",
	initial: () => ({
		chats: [], defaultModel: null, defaultThinkingLevel: "off", busyMode: DEFAULT_BUSY_MODE,
		autoTitle: false, autoCompaction: true, autoRetry: true, pendingFileDeletes: [],
	}),
	checkpointWhen: () => true,
});

/** Custom provider profiles contain no credentials and are restored before Durable resumes model work. */
export const ProvidersDoc = defineDoc<{ custom: ProviderProfile[] }>({
	kind: "oshawott.providers",
	version: 1,
	scope: "session",
	initial: () => ({ custom: [] }),
	checkpointWhen: () => true,
});

export type AttachmentDelete = { id: string; chat: number; paths: string[] };

/**
 * Attachment files whose last reference a commit removed, recorded in that same commit: a crash or eviction between it
 * and the deletion leaves the intent, which the next Engine completes.
 */
export const AttachmentDeletesDoc = defineDoc<{ pending: AttachmentDelete[] }>({
	kind: "oshawott.attachment-deletes",
	version: 1,
	scope: "session",
	initial: () => ({ pending: [] }),
	checkpointWhen: () => true,
});

export const TargetDoc = defineDoc<{ tabId: number | null }>({
	kind: "oshawott.target",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ tabId: null }),
	checkpointWhen: () => true,
});
