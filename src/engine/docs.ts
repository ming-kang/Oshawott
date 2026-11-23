import { defineDoc } from "@earendil-works/pi-durable";
import {
	DEFAULT_BUSY_MODE, type BusyMode, type ModelRef, PREFERENCE_DEFAULTS, type Preference, type ProviderProfile, type ThinkingLevel,
} from "../contracts/chat.ts";

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
	/** Idempotence key of the forkChat call that created this chat; a retried call returns this chat instead of forking again. */
	forkRequestId?: string;
};

export type WorkspaceState = {
	chats: WorkspaceChat[];
	defaultModel: ModelRef | null;
	/** Absent in older documents, whose thinking preference is Off. */
	defaultThinkingLevel?: ThinkingLevel;
	/** Absent in older documents, whose delivery preference is Steer. */
	busyMode?: BusyMode;
	/** The switches; an older document may lack some, which then have their `PREFERENCE_DEFAULTS` value. */
	autoTitle?: boolean;
	autoCompaction?: boolean;
	autoRetry?: boolean;
	confirmActions?: boolean;
	/** Global native Durable instructions, shared by every chat; absent means the built-in text. */
	instructions?: string;
	/** Legacy chat deletion intents, migrated to FileDeletesDoc on startup. */
	pendingFileDeletes?: number[];
};

export const WorkspaceDoc = defineDoc<WorkspaceState>({
	kind: "oshawott.workspace",
	version: 1,
	scope: "session",
	initial: () => ({
		chats: [], defaultModel: null, defaultThinkingLevel: "off", busyMode: DEFAULT_BUSY_MODE, ...PREFERENCE_DEFAULTS,
	}),
	checkpointWhen: () => true,
});

export const preference = (workspace: WorkspaceState | undefined, key: Preference): boolean => workspace?.[key] ?? PREFERENCE_DEFAULTS[key];

/** Custom provider profiles contain no credentials and are restored before Durable resumes model work. */
export const ProvidersDoc = defineDoc<{ custom: ProviderProfile[] }>({
	kind: "oshawott.providers",
	version: 1,
	scope: "session",
	initial: () => ({ custom: [] }),
	checkpointWhen: () => true,
});

export type FileDelete = { id: string; chat: number; paths?: string[] };

/**
 * Deletions are recorded in the same commit that removes a chat or the last reference to its files.
 * No paths means clear the whole chat. Keep the original document kind so outstanding attachment intents survive upgrades.
 */
export const FileDeletesDoc = defineDoc<{ pending: FileDelete[] }>({
	kind: "oshawott.attachment-deletes",
	version: 1,
	scope: "session",
	initial: () => ({ pending: [] }),
	checkpointWhen: () => true,
});

export type TargetState = {
	tabId: number | null;
	/** The HTTP origin or local document URL the target was bound to; a change re-binds and is noted once. */
	origin?: string;
	/** Tabs this chat opened, each with the broker session it was opened under. Absent in older documents. */
	opened?: { tabId: number; session: string }[];
	/** The tab group this chat's opened tabs join; absent in older documents and where grouping is unavailable. */
	groupId?: number;
};

export const TargetDoc = defineDoc<TargetState>({
	kind: "oshawott.target",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ tabId: null }),
	checkpointWhen: () => true,
});
