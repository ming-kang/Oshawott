import type { ChatSummary } from "../contracts/chat.ts";

export type ChatGroupKey = "today" | "yesterday" | "week" | "earlier";
export type ChatGroup = { key: ChatGroupKey; chats: ChatSummary[] };
/** `query` matches titles as the list shows them: an untitled chat by the `untitled` label. */
export type ChatSearch = { query: string; untitled: string };

/** Newest first, bucketed by local calendar day; a search keeps the chats whose title contains its query. */
export function groupChats(chats: readonly ChatSummary[], now: number, search: ChatSearch = { query: "", untitled: "" }): ChatGroup[] {
	const startOfDay = (daysAgo: number) => {
		const date = new Date(now);
		date.setHours(0, 0, 0, 0);
		// Calendar arithmetic, not 24-hour steps: a daylight-saving day is not 24 hours long.
		date.setDate(date.getDate() - daysAgo);
		return date.getTime();
	};
	const bounds: [ChatGroupKey, number][] = [["today", startOfDay(0)], ["yesterday", startOfDay(1)], ["week", startOfDay(7)]];
	const needle = search.query.trim().toLowerCase();
	const groups = new Map<ChatGroupKey, ChatSummary[]>();
	for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
		if (needle && !(chat.title || search.untitled).toLowerCase().includes(needle)) continue;
		const key = bounds.find(([, start]) => chat.updatedAt >= start)?.[0] ?? "earlier";
		const group = groups.get(key);
		if (group) group.push(chat);
		else groups.set(key, [chat]);
	}
	return [...groups].map(([key, items]) => ({ key, chats: items }));
}
