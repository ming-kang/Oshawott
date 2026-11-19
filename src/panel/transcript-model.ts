import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord, LiveState, TaskId, TranscriptItem as DurableItem, TranscriptView } from "@earendil-works/pi-durable";
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

export type TranscriptRow =
	| { key: string; kind: "item"; item: TranscriptItem }
	| { key: string; kind: "run"; items: readonly TranscriptItem[]; calls: readonly { id: string; name: string }[]; failures: number };

const RUN_FOLD_THRESHOLD = 3;

const toolCalls = (item: TranscriptItem): { id: string; name: string }[] => {
	if (item.kind !== "entry" || item.entry.kind !== "pi.assistant") return [];
	const message = item.entry.model?.[0];
	if (message?.role !== "assistant" || message.stopReason === "error") return [];
	const hasText = message.content.some((block) => block.type === "text" && block.text.trim());
	if (hasText) return [];
	return message.content.flatMap((block) => block.type === "toolCall" ? [{ id: block.id, name: block.name }] : []);
};

const isToolResult = (item: TranscriptItem): boolean =>
	item.kind === "entry" && item.entry.kind === "pi.tool-result" && item.entry.model?.[0]?.role === "toolResult";

/**
 * Collapse a maximal sequence of tool-call-only assistant entries and their results once it
 * holds more calls than the threshold. A run still at the committed tail stays open while busy.
 */
export function groupToolRuns(items: readonly TranscriptItem[], busy: boolean): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const lastEntry = items.findLast((item) => item.kind === "entry");
	let run: TranscriptItem[] = [];
	let calls: { id: string; name: string }[] = [];
	let failures = 0;
	const flush = () => {
		if (!run.length) return;
		if (calls.length > RUN_FOLD_THRESHOLD && !(busy && run.at(-1) === lastEntry)) {
			rows.push({ key: `run:${run[0]!.key}`, kind: "run", items: run, calls, failures });
		} else {
			for (const item of run) rows.push({ key: item.key, kind: "item", item });
		}
		run = [];
		calls = [];
		failures = 0;
	};
	for (const item of items) {
		const itemCalls = toolCalls(item);
		if (itemCalls.length) {
			run.push(item);
			calls.push(...itemCalls);
		} else if (run.length && isToolResult(item)) {
			run.push(item);
			const message = item.kind === "entry" ? item.entry.model?.[0] : undefined;
			if (message?.role === "toolResult" && message.isError) failures++;
		} else {
			flush();
			rows.push({ key: item.key, kind: "item", item });
		}
	}
	flush();
	return rows;
}

export function hasVisibleAnswer(items: readonly TranscriptItem[]) {
	return items.some((item) => {
		if (item.kind === "live") return true;
		if (item.kind !== "entry") return false;
		return item.entry.kind === "pi.user" || item.entry.kind === USER_ENTRY || item.entry.kind === "pi.assistant";
	});
}

export type ErrorNoticeSpec =
	| { mode: "normal" | "suppressed"; raw: string }
	| { mode: "recovered"; raw: string; raws: readonly string[] }
	| { mode: "retrying"; raw: string; at: number };

function errorRaw(item: TranscriptItem | undefined): string | undefined {
	if (item?.kind !== "entry" || item.entry.kind !== "pi.assistant") return undefined;
	const message = item.entry.model?.[0];
	return message?.role === "assistant" && message.stopReason === "error" ? message.errorMessage : undefined;
}

type PresentedItem = { item: TranscriptItem; notice?: ErrorNoticeSpec; forkFrom?: EntryId };

export function transcriptRows(items: readonly TranscriptItem[], live: LiveState | undefined) {
	const busy = Boolean(live?.run);
	const retry = live?.generation?.retry;
	const failure = busy ? undefined : live?.runFailure;
	const lastEntry = items.findLast((item) => item.kind === "entry");
	const lastAssistant = items.findLastIndex((item) => item.kind === "entry" && item.entry.kind === "pi.assistant");
	const presentation = new Map<TranscriptItem, PresentedItem>();
	let lastUser: EntryId | undefined;
	let recovered: { row: PresentedItem; raw: string }[] = [];
	const flush = () => {
		const last = recovered.at(-1);
		if (!last) return;
		last.row.notice = { mode: "recovered", raw: last.raw, raws: recovered.map(({ raw }) => raw) };
		recovered = [];
	};
	for (const [index, item] of items.entries()) {
		const row: PresentedItem = { item };
		presentation.set(item, row);
		if (item.kind === "entry") {
			if (item.entry.kind === "pi.user" || item.entry.kind === USER_ENTRY) lastUser = item.entry.id;
			else if (item.entry.kind === "pi.assistant") row.forkFrom = lastUser;
		}
		const raw = errorRaw(item);
		if (raw === undefined) { flush(); continue; }
		if (item === lastEntry && retry) {
			flush();
			row.notice = { mode: "retrying", raw, at: retry.at };
		} else if (item === lastEntry && failure?.reason === "model_error") {
			flush();
			row.notice = { mode: "suppressed", raw };
		} else if (index < lastAssistant) {
			row.notice = { mode: "suppressed", raw };
			recovered.push({ row, raw });
		} else {
			flush();
			row.notice = { mode: "normal", raw };
		}
	}
	flush();
	return {
		lastError: errorRaw(lastEntry),
		rows: groupToolRuns(items, busy).map((row) => row.kind === "run"
			? { ...row, items: row.items.map((item) => presentation.get(item)!) }
			: { ...row, row: presentation.get(row.item)! }),
	};
}
