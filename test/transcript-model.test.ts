import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type EntryRecord, type LiveState, type TaskId, type TranscriptView } from "@earendil-works/pi-durable";
import { transcriptItems } from "../src/panel/transcript-model.ts";

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
