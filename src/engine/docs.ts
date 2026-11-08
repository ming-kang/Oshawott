import { defineDoc } from "@earendil-works/pi-durable";
import { DEFAULT_BUSY_MODE, type BusyMode, type ChatSummary, type ModelRef, type ProviderProfile, type ThinkingLevel } from "../contracts/chat.ts";

export type WorkspaceState = {
	chats: ChatSummary[];
	defaultModel: ModelRef | null;
	/** Absent in older documents, whose thinking preference is Off. */
	defaultThinkingLevel?: ThinkingLevel;
	/** Absent in older documents, whose delivery preference is Steer. */
	busyMode?: BusyMode;
	/** Optional for older v1 documents. An intent survives eviction between removing a chat and clearing its files. */
	pendingFileDeletes?: number[];
};

export const WorkspaceDoc = defineDoc<WorkspaceState>({
	kind: "oshawott.workspace",
	version: 1,
	scope: "session",
	initial: () => ({ chats: [], defaultModel: null, defaultThinkingLevel: "off", busyMode: DEFAULT_BUSY_MODE, pendingFileDeletes: [] }),
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
