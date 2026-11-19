// Request-shaping only, wired from the browser extension's beforeRequest hook: durable history is untouched.
// Superseded page reads shrink to a stub and old screenshots leave a note, so each request carries the reads
// that still matter — the model no longer sees a snapshot the same-scope later read replaced.

import type { ImageContent, Message, TextContent, ToolCall } from "@earendil-works/pi-ai";

const READS = new Set(["page_snapshot", "page_inspect"]);
const KEEP_SCREENSHOTS = 3;
const SCREENSHOT_CHUNK = 3;

const isText = (part: TextContent | ImageContent): part is TextContent => part.type === "text";

/** Sorted-key JSON: scope arguments compare by content, not by the order the model wrote them. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, each) =>
		each !== null && typeof each === "object" && !Array.isArray(each)
			? Object.fromEntries(Object.keys(each as Record<string, unknown>).sort().map((key) => [key, (each as Record<string, unknown>)[key]]))
			: each);

/**
 * A copy of `messages` — never a mutation of it — where every page read a later same-scope read replaced is
 * stubbed to its Title/URL lines plus a note, and all but the newest three screenshots are removed in chunks
 * of three for prompt-cache stability. Returns the same array when nothing applies.
 */
export function trimPageReads(messages: readonly Message[]): readonly Message[] {
	const calls = new Map<string, ToolCall>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
	}
	const reads: { index: number; key: string }[] = [];
	const screenshots: { index: number; part: number }[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role !== "toolResult" || message.isError) continue;
		if (READS.has(message.toolName)) {
			const text = message.content.find(isText)?.text ?? "";
			const url = /^URL: (.+)$/m.exec(text)?.[1];
			if (url === undefined) continue;
			const { tabId: _tabId, maxChars: _maxChars, ...scope } = calls.get(message.toolCallId)?.arguments ?? {};
			reads.push({ index, key: `${message.toolName} ${url} ${canonical(scope)}` });
		} else if (message.toolName === "page_screenshot") {
			for (const [part, content] of message.content.entries()) if (content.type === "image") screenshots.push({ index, part });
		}
	}
	const latest = new Map(reads.map((read) => [read.key, read.index]));
	const stubs = new Set(reads.filter((read) => latest.get(read.key) !== read.index).map((read) => read.index));
	const dropShots = new Set(
		screenshots.slice(0, Math.floor(Math.max(0, screenshots.length - KEEP_SCREENSHOTS) / SCREENSHOT_CHUNK) * SCREENSHOT_CHUNK)
			.map((shot) => `${shot.index}:${shot.part}`),
	);
	if (!stubs.size && !dropShots.size) return messages;
	return messages.map((message, index) => {
		if (message.role !== "toolResult") return message;
		if (stubs.has(index)) {
			const text = message.content.find(isText)?.text ?? "";
			const head = text.match(/^(?:Title|URL): .+$/gm) ?? [];
			const note = `[Outdated: a later ${message.toolName} with the same scope replaced this result; refs stay stable, so read the newer one.]`;
			return { ...message, content: [{ type: "text" as const, text: [...head, note].join("\n") }] };
		}
		if (message.toolName === "page_screenshot") {
			const content = message.content.map((content, part) =>
				dropShots.has(`${index}:${part}`) ? { type: "text" as const, text: "[Earlier screenshot removed to save context.]" } : content);
			return content.some((part, index) => part !== message.content[index]) ? { ...message, content } : message;
		}
		return message;
	});
}
