import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationView, type EntryId, type EntryRecord, type LiveState, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { t } from "../i18n/index.ts";
import { TranscriptFixture } from "./fixtures.tsx";
import { ToolCard } from "../tool-card.ts";

export async function testToolCards() {
	const metaOf = (card: ToolCard) => card.element.querySelector(".tool-meta")?.textContent;
	const fetched = new ToolCard("fetch", { url: "https://args.example/items.json" });
	fetched.setResult("Downloaded (no HTTP summary).", false, { http: { status: 201, bytes: 1536 } });
	const httpMeta = metaOf(fetched);
	fetched.setResult("HTTP 200 OK · text/plain · 999 bytes", false);
	const legacyHttpIgnored = metaOf(fetched) === "args.example/items.json";
	fetched.setResult("HTTP 200 OK · text/plain · 999 bytes", false, { http: { status: "200", bytes: -1 } });
	const malformedHttpIgnored = metaOf(fetched) === "args.example/items.json";

	const snapshot = new ToolCard("page_snapshot", {});
	const snapshotText = "Title: Output title\nURL: https://example.com/\nElements (0):\nText:\n";
	snapshot.setResult(snapshotText, false, { snapshot: { title: "UI title", elementCount: 3 } });
	const snapshotMeta = metaOf(snapshot);
	snapshot.setResult(snapshotText, false);
	const legacySnapshotIgnored = metaOf(snapshot) === "";

	const inspect = new ToolCard("page_inspect", { selector: ".item" });
	const inspectArgs = metaOf(inspect);
	inspect.setResult("{}", false, { inspect: { matched: 30, shown: 5 } });
	const inspectMeta = metaOf(inspect);
	const inspectText = "URL: https://example.com/\nMatched: 3\n\n[e1] div visible\n<div>Full HTML</div>";
	inspect.setResult(inspectText, false, {
		kind: "page_inspect", url: "https://example.com/", matched: 3, truncated: true, previewTruncated: true,
		elements: [{ ref: "e1", tag: "div", visible: true, truncated: false, html: "<div>Full…" }],
	});
	const inspectPreview = metaOf(inspect) === `.item · ${t("tool.inspected", 1, 3)}`
		&& inspect.element.querySelector(".tv-inspect-item")?.textContent?.includes("<div>Full…")
		&& inspect.element.querySelector(".tv-note")?.textContent === t("tool.inspectPreview");
	inspect.element.querySelector<HTMLButtonElement>(".tool-toggle")?.click();
	const inspectRaw = inspect.element.querySelector(".tool-raw-pre")?.textContent === inspectText;

	const edit = new ToolCard("edit", { path: "app.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] });
	edit.setResult("Successfully replaced 1 block(s) in app.ts.", false, { diff: "-1 const a = 1;\n+1 const a = 2;" });
	const hasDiff = Boolean(edit.element.querySelector('.tv-diff-line[data-kind="del"]'))
		&& Boolean(edit.element.querySelector('.tv-diff-line[data-kind="add"]'))
		&& !edit.element.querySelector(".tool-panel-content")?.textContent?.includes('"edits"');
	edit.element.querySelector<HTMLButtonElement>(".tool-toggle")?.click();
	const rawToggleWorks = Boolean(edit.element.querySelector(".tool-raw-label"))
		&& Boolean(edit.element.querySelector(".tool-panel-content")?.textContent?.includes('"edits"'));

	const write = new ToolCard("write", { path: "notes.md", content: "# Hello\nWorld" });
	const writeOmitsJson = !write.element.querySelector(".tool-panel-content")?.textContent?.includes('"content"');

	const press = new ToolCard("page_press", { modifiers: ["Shift"], key: "Escape" });
	press.setResult(JSON.stringify({ ok: true }), false);
	const pressHeadlessKeycaps = press.element.querySelectorAll(".tv-kbd").length === 2
		&& !press.element.querySelector(".tool-panel-head")
		&& press.element.querySelector<HTMLElement>(".tool-panel")?.dataset.headless === "true";

	const errorCard = new ToolCard("fetch", { url: "https://denied.example/" });
	errorCard.setResult("<harness>\n[error] Connection refused\n</harness>", true);
	const errorLine = errorCard.element.querySelector(".tool-error")?.textContent;

	const rawOnlyResult = new ToolCard("tabs_list", {});
	rawOnlyResult.setResult("Error: failed", true);
	const noDuplicateResultLabel = !rawOnlyResult.element.querySelector(".tool-raw-label");

	const codeError = new ToolCard("codemode", { code: "return 1;" });
	codeError.setResult("Script failed\nWall time 0.1 seconds\nOutput:\nScript error:\nError: boom", true);
	const codeErrorLine = codeError.element.querySelector(".tool-error")?.textContent;

	const actions = { suggest: () => {}, openSettings: () => {}, chooseModel: () => {}, readFile: async () => new Uint8Array(), retry: async () => undefined };
	const transcript = new TranscriptFixture(actions);
	const conversationId = ROOT_CONVERSATION_ID;
	const entries: EntryRecord[] = [{
		id: 1 as EntryId, conversationId, kind: "pi.assistant",
		model: [fauxAssistantMessage([
			fauxToolCall("fetch", { url: "https://args.example/" }, { id: "fetched" }),
			fauxToolCall("read", { path: "notes.txt" }, { id: "failed" }),
		], { stopReason: "toolUse" })],
	}];
	const live: LiveState = {
		run: { taskId: 1 as TaskId, inputs: [], turns: 0 },
		tools: [{ callId: "fetched", name: "fetch", status: "running", output: "Downloading" }],
	};
	const view: ConversationView = { conversation: { id: conversationId }, entries, docs: { "pi.live": live } };
	let forwarded = false;
	document.body.append(transcript.element);
	try {
		await transcript.update({ kind: "conversation", view, ready: true });
		const running = transcript.element.querySelector<HTMLDetailsElement>(".tool")!;
		const wasRunning = running.dataset.status === "running";
		entries.push({
			id: 2 as EntryId, conversationId, kind: "pi.tool-result", data: { diagnostics: [] },
			model: [{ role: "toolResult", toolCallId: "fetched", toolName: "fetch", content: [{ type: "text", text: "Done." }],
				details: { http: { status: 206, bytes: 2048 } }, isError: false, timestamp: 0 }],
		}, ...["failed", "orphan"].map((toolCallId, index): EntryRecord => ({
			id: (3 + index) as EntryId, conversationId, kind: "pi.tool-result", data: { diagnostics: [] },
			model: [{ role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: "File not found." }],
				isError: true, timestamp: 0 }],
		})));
		await transcript.update({ kind: "conversation", view: { ...view, docs: {} }, ready: true });
		const rendered = [...transcript.element.querySelectorAll<HTMLDetailsElement>(".tool")];
		forwarded = wasRunning && rendered.length === 3 && rendered[0] === running && running.dataset.status === "done"
			&& running.querySelector(".tool-meta")?.textContent === "args.example · HTTP 206 · 2 KiB"
			&& rendered.slice(1).every((card) => card.dataset.status === "error" && Boolean(card.querySelector(".tool-error")));
	} finally {
		transcript.dispose();
		transcript.element.remove();
	}

	const folded = new TranscriptFixture(actions);
	const runNames = ["ls", "read", "fetch", "codemode"];
	const runEntries: EntryRecord[] = [
		{
			id: 10 as EntryId, conversationId, kind: "pi.assistant",
			model: [fauxAssistantMessage(runNames.map((name, index) => fauxToolCall(name, {}, { id: `run-${index}` })), { stopReason: "toolUse" })],
		},
		...runNames.map((name, index): EntryRecord => ({
			id: (11 + index) as EntryId, conversationId, kind: "pi.tool-result", data: { diagnostics: [] },
			model: [{ role: "toolResult", toolCallId: `run-${index}`, toolName: name, content: [{ type: "text", text: `result ${index}` }], isError: index === 1, timestamp: 0 }],
		})),
		{ id: 15 as EntryId, conversationId, kind: "pi.assistant", model: [fauxAssistantMessage("Finished")] },
	];
	let foldOk = false;
	document.body.append(folded.element);
	try {
		await folded.update({ kind: "conversation", view: { conversation: { id: conversationId }, entries: runEntries, docs: {} }, ready: true });
		const fold = folded.element.querySelector<HTMLDetailsElement>(".run-fold");
		const cards = [...(fold?.querySelectorAll<HTMLDetailsElement>(".tool") ?? [])];
		foldOk = fold !== null && fold.open === false && cards.length === 4
			&& cards.filter((card) => card.dataset.status === "done").length === 3
			&& cards.some((card) => card.dataset.status === "error")
			&& fold.querySelector(".run-fold-label")?.textContent === t("run.actions", 4)
			&& fold.querySelector(".run-fold-failures")?.textContent === t("run.failed", 1);
	} finally {
		folded.dispose();
		folded.element.remove();
	}
	return [
		{ name: "fetch metadata combines target and details, ignoring legacy prose or malformed details", ok: httpMeta === "args.example/items.json · HTTP 201 · 1.5 KiB" && legacyHttpIgnored && malformedHttpIgnored, detail: httpMeta },
		{ name: "inspect cards keep the target and how many elements were shown", ok: inspectArgs === ".item" && inspectMeta === `.item · ${t("tool.inspected", 5, 30)}`, detail: inspectMeta },
		{ name: "shortened inspect cards explain the preview and can switch to the original tool output", ok: Boolean(inspectPreview && inspectRaw) },
		{ name: "snapshot metadata uses details, not model-facing JSON", ok: snapshotMeta === `UI title · ${t("tool.elements", 3)}` && legacySnapshotIgnored, detail: snapshotMeta },
		{ name: "edit and write cards render diff and file content cleanly with raw fallback toggle", ok: hasDiff && rawToggleWorks && writeOmitsJson && pressHeadlessKeycaps },
		{ name: "Transcript forwards result details to running and orphaned cards", ok: forwarded },
		{ name: "failed cards surface the first error line under the summary", ok: errorLine === "Connection refused" && codeErrorLine === "Error: boom" && noDuplicateResultLabel, detail: `${errorLine} / ${codeErrorLine}` },
		{ name: "long tool runs fold into one counted group, still delivering results", ok: foldOk },
	];
}
