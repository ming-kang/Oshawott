import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, TaskId, TranscriptItem as DurableItem, TranscriptView } from "@earendil-works/pi-durable";
import { USER_ENTRY } from "../lib/attachments.ts";

export type TranscriptItem =
	| { key: string; kind: "entry"; entry: EntryRecord }
	| { key: string; kind: "live"; message: AssistantMessage; taskId: TaskId; attempt: number }
	| { key: string; kind: "earlier" }
	| { key: string; kind: "gap"; gap: Extract<DurableItem, { kind: "gap" }> };

/** Scheduler-salvaged partial entries can lack byTaskId. Only adopt an unmistakable continuation. */
function continuesResponse(before: AssistantMessage, after: AssistantMessage): boolean {
	if (before.timestamp !== after.timestamp || before.provider !== after.provider || before.model !== after.model || before.content.length > after.content.length) return false;
	return before.content.every((block, index) => {
		const next = after.content[index];
		if (block.type === "text") return next?.type === "text" && next.text.startsWith(block.text);
		if (block.type === "thinking") return next?.type === "thinking" && next.thinking.startsWith(block.thinking);
		return next?.type === "toolCall" && next.id === block.id && next.name === block.name;
	});
}

function hasContent(message: AssistantMessage | undefined) {
	return message?.content.some((block) => (block.type === "text" && block.text) || (block.type === "thinking" && block.thinking) || block.type === "toolCall");
}

/**
 * Pure live-to-committed identity reconciliation. The previous live key moves to its committed
 * entry, so Vue keeps the same AssistantView, disclosures, selection and code scroll position.
 */
export function transcriptItems(view: TranscriptView, previous: readonly TranscriptItem[] = []): TranscriptItem[] {
	const previousLive = previous.find((item): item is Extract<TranscriptItem, { kind: "live" }> => item.kind === "live");
	const previousEntries = new Map(previous.flatMap((item) => item.kind === "entry" ? [[item.entry.id, item.key] as const] : []));
	const items: TranscriptItem[] = [];
	for (const item of view.items) {
		if (item.kind === "earlier") items.push({ key: "earlier", kind: "earlier" });
		else if (item.kind === "gap") items.push({ key: `gap:${item.after}:${item.upTo}`, kind: "gap", gap: item });
		else {
			const entry = item.entry;
			let key = previousEntries.get(entry.id) ?? `entry:${entry.id}`;
			// Promotion is for a newly committed entry only. An older committed answer must never
			// consume a later generation merely because Durable reused its task ID.
			if (!previousEntries.has(entry.id) && entry.kind === "pi.assistant" && previousLive) {
				const message = entry.model?.[0];
				if (message?.role === "assistant" && (entry.byTaskId === undefined || entry.byTaskId === previousLive.taskId)
					&& continuesResponse(previousLive.message, message)) key = previousLive.key;
			}
			items.push({ key, kind: "entry", entry });
		}
	}
	const live = view.docs["pi.live"] as LiveState | undefined;
	const message = live?.generation?.message;
	if (live?.run && message && hasContent(message)) {
		const occupied = new Set(items.map((item) => item.key));
		const base = `live:${live.run.taskId}:${live.generation!.attempt}`;
		let key = base;
		for (let suffix = 1; occupied.has(key); suffix++) key = `${base}:active:${suffix}`;
		items.push({ key, kind: "live", message, taskId: live.run.taskId, attempt: live.generation!.attempt });
	}
	return items;
}

export function hasVisibleAnswer(items: readonly TranscriptItem[]) {
	return items.some((item) => {
		if (item.kind === "live") return true;
		if (item.kind !== "entry") return false;
		return item.entry.kind === "pi.user" || item.entry.kind === USER_ENTRY || item.entry.kind === "pi.assistant";
	});
}
