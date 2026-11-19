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
