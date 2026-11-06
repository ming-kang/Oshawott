// The Engine's own state, stored in Durable next to the transcripts: one storage, one owner, one commit line.
import { defineDoc } from "@earendil-works/pi-durable";

export type ModelRef = { provider: string; modelId: string };
export type ChatSummary = { id: number; title: string; createdAt: number };

/** The workspace: the chats in creation order and the model new chats start with. */
export const WorkspaceDoc = defineDoc<{ chats: ChatSummary[]; defaultModel: ModelRef | null }>({
	kind: "oshawatt.workspace",
	version: 1,
	scope: "session",
	initial: () => ({ chats: [], defaultModel: null }),
	checkpointWhen: () => true,
});

/** The tab a conversation's page tools act on when a call names none: the tab its panel showed at the last send. */
export const TargetDoc = defineDoc<{ tabId: number | null }>({
	kind: "oshawatt.target",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ tabId: null }),
	checkpointWhen: () => true,
});
