import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type EntryRecord, type LiveState, type TaskId, type TranscriptView } from "@earendil-works/pi-durable";
import { groupToolRuns, transcriptItems } from "../src/panel/transcript-model.ts";

const taskId = 42 as TaskId;
const committed = (id = 1, text = "Attempt 1"): EntryRecord => ({
	id: id as EntryRecord["id"], conversationId: ROOT_CONVERSATION_ID, byTaskId: taskId, kind: "pi.assistant",
	model: [fauxAssistantMessage(text, { timestamp: 1_700_000_000_000 })],
});
function view(entries: EntryRecord[], live?: LiveState): TranscriptView {
	return { conversation: { id: ROOT_CONVERSATION_ID }, items: entries.map((entry) => ({ kind: "entry", entry })), docs: live ? { "pi.live": live } : {} };
}
function streaming(attempt = 1): LiveState {
	const partial = fauxAssistantMessage(`Attempt ${attempt}`, { timestamp: 1_700_000_000_000 });
	const text = `Attempt ${attempt}`;
	const message = {
		role: "assistant" as const, content: [{ type: "text" as const, text }], api: partial.api, provider: partial.provider,
		model: partial.model, usage: partial.usage, stopReason: partial.stopReason, timestamp: partial.timestamp,
	};
	return { run: { taskId, inputs: [], turns: 0 }, generation: { attempt, message } };
}

test("a newly committed answer inherits its live identity", () => {
	const streamed = transcriptItems(view([], streaming()));
	const live = streamed.find((item) => item.kind === "live");
	const finished = transcriptItems(view([committed()]), streamed);
	assert.equal(finished.length, 1);
	assert.equal(finished[0]?.kind, "entry");
	assert.equal(finished[0]?.key, live?.key);
});

test("an existing committed answer never consumes a later generation with the same task", () => {
	const first = transcriptItems(view([], streaming()));
	const finished = transcriptItems(view([committed()]), first);
	const restarted = transcriptItems(view([committed()], streaming()), finished);
	assert.equal(restarted.length, 2);
	assert.equal(restarted[0]?.key, finished[0]?.key);
	assert.notEqual(restarted[1]?.key, finished[0]?.key);

	const nextAttempt = transcriptItems(view([committed()], streaming(2)), restarted);
	assert.equal(nextAttempt.length, 2);
	assert.equal(nextAttempt[0]?.key, finished[0]?.key);
	assert.equal(nextAttempt.some((item) => item.key === restarted[1]?.key), false);
	assert.equal(nextAttempt[1]?.kind, "live");
});

test("a different generation from the same task is not a continuation", () => {
	const streamed = transcriptItems(view([], streaming(2)));
	const previousTurn = committed(1, "Attempt 1 is final and does not prefix attempt 2");
	const next = transcriptItems(view([previousTurn], streaming(2)), streamed);
	assert.equal(next[0]?.key, "entry:1");
	assert.notEqual(next[1]?.key, next[0]?.key);
});

test("an unrelated committed entry cannot take the active live identity", () => {
	const streamed = transcriptItems(view([], streaming()));
	const unrelated = { ...committed(), byTaskId: 99 as TaskId };
	const next = transcriptItems(view([unrelated], streaming()), streamed);
	assert.equal(next.length, 2);
	assert.equal(next[0]?.key, "entry:1");
	assert.equal(next[1]?.key, streamed[0]?.key);
});

const calls = (id: number, names: string[], text?: string): EntryRecord => ({
	id: id as EntryRecord["id"], conversationId: ROOT_CONVERSATION_ID, byTaskId: taskId, kind: "pi.assistant",
	model: [fauxAssistantMessage([
		...(text ? [{ type: "text" as const, text }] : []),
		...names.map((name, index) => fauxToolCall(name, {}, { id: `${id}-${index}` })),
	], { stopReason: "toolUse" })],
});
const result = (id: number, callId: string, name: string, isError = false): EntryRecord => ({
	id: id as EntryRecord["id"], conversationId: ROOT_CONVERSATION_ID, kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }], isError, timestamp: 0 }],
});
const user = (id: number): EntryRecord => ({
	id: id as EntryRecord["id"], conversationId: ROOT_CONVERSATION_ID, kind: "pi.user",
	model: [{ role: "user", content: "hi", timestamp: 0 }],
});
const runsOf = (entries: EntryRecord[], busy = false) => groupToolRuns(transcriptItems(view(entries)), busy);

test("a tool-only run past the threshold folds into one group", () => {
	const entries: EntryRecord[] = [
		calls(1, ["a", "b", "c", "d"]), result(2, "1-0", "a"), result(3, "1-1", "b"), result(4, "1-2", "c", true), result(5, "1-3", "d"),
		{ id: 6 as EntryRecord["id"], conversationId: ROOT_CONVERSATION_ID, byTaskId: taskId, kind: "pi.assistant", model: [fauxAssistantMessage("All done")] },
	];
	const rows = runsOf(entries);
	assert.equal(rows.length, 2);
	assert.equal(rows[0]?.kind, "run");
	if (rows[0]?.kind !== "run") return;
	assert.equal(rows[0].calls.length, 4);
	assert.equal(rows[0].failures, 1);
	assert.equal(rows[0].items.length, 5);
	assert.equal(rows[1]?.kind, "item");
});

test("a run at or below the threshold stays flat", () => {
	const rows = runsOf([calls(1, ["a", "b", "c"]), result(2, "1-0", "a"), result(3, "1-1", "b"), result(4, "1-2", "c")]);
	assert.deepEqual(rows.map((row) => row.kind), ["item", "item", "item", "item"]);
});

test("a text block or a user message breaks a run", () => {
	const rows = runsOf([
		calls(1, ["a", "b", "c", "d"]), result(2, "1-0", "a"), result(3, "1-1", "b"), result(4, "1-2", "c"), result(5, "1-3", "d"),
		calls(6, ["e"], "A word before the next call"), result(7, "6-0", "e"),
		user(8),
		calls(9, ["f", "g", "h", "i"]), result(10, "9-0", "f"), result(11, "9-1", "g"), result(12, "9-2", "h"), result(13, "9-3", "i"),
	]);
	const kinds = rows.map((row) => row.kind);
	assert.deepEqual(kinds, ["run", "item", "item", "item", "run"]);
});

test("a run still at the committed tail stays open while busy", () => {
	const entries = [calls(1, ["a", "b", "c", "d"]), result(2, "1-0", "a"), result(3, "1-1", "b"), result(4, "1-2", "c"), result(5, "1-3", "d")];
	assert.deepEqual(runsOf(entries, true).map((row) => row.kind), ["item", "item", "item", "item", "item"]);
	assert.equal(runsOf(entries, false)[0]?.kind, "run");
});
