import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatSummary } from "../src/contracts/chat.ts";
import { groupChats } from "../src/panel/chat-groups.ts";

const at = (...parts: [number, number, number, number?, number?]) => new Date(...parts).getTime();
const chat = (id: number, title: string, updatedAt: number): ChatSummary => ({ id, title, createdAt: updatedAt, updatedAt, status: "idle" });

test("chats are grouped by local calendar day, newest first", () => {
	const now = at(2026, 10, 15, 0, 5);
	const groups = groupChats([
		chat(1, "last week", at(2026, 10, 8, 0, 0)),
		chat(2, "five minutes before midnight", at(2026, 10, 14, 23, 55)),
		chat(3, "just now", at(2026, 10, 15, 0, 4)),
		chat(4, "long ago", at(2026, 10, 7, 23, 59)),
		chat(5, "midnight", at(2026, 10, 15, 0, 0)),
	], now);
	assert.deepEqual(groups.map((group) => [group.key, group.chats.map((item) => item.id)]), [
		["today", [3, 5]], ["yesterday", [2]], ["week", [1]], ["earlier", [4]],
	]);
});

test("a query matches titles as shown and drops the groups it empties", () => {
	const now = at(2026, 10, 15, 12);
	const chats = [chat(1, "Tide Tables", now), chat(2, "Invoices", at(2026, 10, 14, 12)), chat(3, "", at(2026, 10, 14, 13))];
	const found = (query: string) => groupChats(chats, now, { query, untitled: "Untitled" }).map((group) => [group.key, group.chats.map((item) => item.id)]);
	assert.deepEqual(found("  tide "), [["today", [1]]]);
	assert.deepEqual(found("untitled"), [["yesterday", [3]]]);
});
