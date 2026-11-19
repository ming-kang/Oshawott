import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { test } from "node:test";
import { trimPageReads } from "../src/engine/context-trim.ts";
import type { ToolDetails } from "../src/tools/details.ts";

const result = (id: string, toolName: string, content: ToolResultMessage["content"], isError = false, details?: ToolDetails): ToolResultMessage =>
	({ role: "toolResult", toolCallId: id, toolName, content, isError, details, timestamp: 0 });

const read = (id: string, args: Record<string, unknown>, text: string): Message[] => [
	fauxAssistantMessage(fauxToolCall("page_snapshot", args as never, { id })),
	result(id, "page_snapshot", [{ type: "text", text }], false,
		{ kind: "page_snapshot", title: "Example", url: "https://a/", text: "", elements: [], elementCount: 0 }),
];

const shot = (id: string): Message[] => [
	fauxAssistantMessage(fauxToolCall("page_screenshot", {}, { id })),
	result(id, "page_screenshot", [
		{ type: "text", text: `Screenshot ${id}` },
		{ type: "image", data: "AAAA", mimeType: "image/jpeg" },
	]),
];

const textOf = (message: Message) =>
	(message as ToolResultMessage).content.map((part) => (part.type === "text" ? part.text : "<image>")).join("\n");

test("a superseded page read shrinks to a stub; the latest and a different scope stay intact", () => {
	const first = "The target changed sites.\nTitle: Example\nURL: https://a/\nElements (1):\n[e1] button \"Go\"\n\nfirst body\nURL: https://quoted-page-text/";
	const messages: Message[] = [
		...read("c1", {}, first),
		...read("c2", { textOffset: 500 }, "Title: Example\nURL: https://a/\nElements (0):\n\ncontinued"),
		...read("c3", {}, "Title: Example\nURL: https://a/\nElements (1):\n[e1] button \"Go\"\n\nnewer body"),
		result("bad", "page_snapshot", [{ type: "text", text: "Title: Example\nURL: https://a/\nblew up" }], true),
	];
	const trimmed = trimPageReads(messages);
	assert.notEqual(trimmed, messages);
	// The superseded read keeps its Title/URL lines and the note, not the stale body or elements.
	assert.equal(
		textOf(trimmed[1]!),
		"Title: Example\nURL: https://a/\n[Outdated: a later page_snapshot with the same scope replaced this result; refs stay stable, so read the newer one.]",
	);
	assert.equal(trimmed[3], messages[3], "a different textOffset is a different scope and stays");
	assert.equal(trimmed[5], messages[5], "the latest read of the scope stays intact");
	assert.equal(trimmed[6], messages[6], "error results are never trimmed");
	assert.equal(textOf(messages[1]!), first, "the input is not mutated");
	const untrimmed = messages.slice(4);
	assert.equal(trimPageReads(untrimmed), untrimmed, "nothing to trim returns the same array");
});

test("legacy reads participate in trimming without using URLs from their body", () => {
	const inspect = (id: string, url: string, details?: ToolDetails): Message[] => [
		fauxAssistantMessage(fauxToolCall("page_inspect", { selector: ".article" }, { id })),
		result(id, "page_inspect", [{ type: "text", text: `URL: ${url}\nMatched: 1\n\n[e1] article visible\nURL: https://in-the-html/` }], false, details),
	];
	const messages = [
		fauxAssistantMessage(fauxToolCall("page_snapshot", {}, { id: "old" })),
		result("old", "page_snapshot", [{ type: "text", text: "Note: the target tab is now on https://a (it was https://b); the user or the page moved it. Check it is still the page this task is about.\nTitle: Legacy\nURL: https://a/\nElements (0):\nText:\nTitle: In the body\nURL: https://in-the-body/" }]),
		...read("new", {}, "Title: Example\nURL: https://a/\nElements (0):\nText:\nnewer body"),
		...inspect("one", "https://a/"),
		...inspect("different", "https://b/"),
		...inspect("latest", "https://a/", { kind: "page_inspect", url: "https://a/", matched: 1, truncated: false, elements: [] }),
		result("invalid", "page_inspect", [{ type: "text", text: "not a header\nURL: https://a/" }]),
	];
	const trimmed = trimPageReads(messages);
	assert.match(textOf(trimmed[1]!), /^Title: Legacy\nURL: https:\/\/a\/\n\[Outdated: .*\]$/);
	assert.match(textOf(trimmed[5]!), /^URL: https:\/\/a\/\n\[Outdated: .*\]$/);
	for (const index of [3, 7, 9, 10]) assert.equal(trimmed[index], messages[index]);
});

test("old page_screenshot images leave a note, in chunks of three", () => {
	const messages: Message[] = [...shot("s1"), ...shot("s2"), ...shot("s3"), ...shot("s4"), ...shot("s5"), ...shot("s6"), ...shot("s7")];
	const trimmed = trimPageReads(messages);
	// Seven images keep the newest three and three more of the chunk: the oldest three become notes.
	for (const [call, index] of [["s1", 1], ["s2", 3], ["s3", 5]] as const) {
		assert.equal(textOf(trimmed[index]!), `Screenshot ${call}\n[Earlier screenshot removed to save context.]`, `${call} stubbed`);
	}
	for (const index of [7, 9, 11, 13]) {
		assert.equal((trimmed[index] as ToolResultMessage).content[1]?.type, "image", `image ${index} kept`);
	}
	assert.equal((messages[1] as ToolResultMessage).content[1]?.type, "image", "the input is not mutated");
});
