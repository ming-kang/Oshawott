import { defineDoc } from "@earendil-works/pi-durable";
import type { ChatSummary, ModelRef } from "../contracts/chat.ts";

export type WorkspaceState = {
	chats: ChatSummary[];
	defaultModel: ModelRef | null;
	/** Optional for older v1 documents. An intent survives eviction between removing a chat and clearing its files. */
	pendingFileDeletes?: number[];
};

export const WorkspaceDoc = defineDoc<WorkspaceState>({
	kind: "oshawott.workspace",
	version: 1,
	scope: "session",
	initial: () => ({ chats: [], defaultModel: null, pendingFileDeletes: [] }),
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
