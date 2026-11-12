import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationView, type EntryId, type EntryRecord, type LiveState, ROOT_CONVERSATION_ID, type TaskId, type ToolDiagnostic } from "@earendil-works/pi-durable";
import { NO_ACCESS_CODE } from "../../contracts/browser.ts";
import { ext } from "../../platform/webext.ts";
import { t } from "../i18n/index.ts";
import { Transcript } from "../render.ts";
import { ToolCard } from "../tool-card.ts";

export async function testToolCards() {
	const names = ["read", "read_text", "write", "edit", "ls", "fetch"];
	const cards = names.map((name) => new ToolCard(name, { path: "notes.md", url: "https://args.example/" }));
	const labels = cards.map((card) => card.element.querySelector(".tool-label")?.textContent);
	const details = { access: { url: "https://denied.example:8443/" } };
	const diagnostics: ToolDiagnostic[] = [{ severity: "error", code: NO_ACCESS_CODE, message: "Permission required." }];
	const error = cards.at(-1)!;
	error.setResult("This site needs permission (wording may change).", true, details, diagnostics);
	document.body.append(error.element);
	const button = error.element.querySelector<HTMLButtonElement>(".tool-grant");
	const original = ext.permissions.request;
	const requests: unknown[] = [];
	let synchronous = false;
	try {
		ext.permissions.request = (permissions) => {
			requests.push(permissions);
			return Promise.resolve(true);
		};
		button?.click();
		synchronous = requests.length === 1;
		await Promise.resolve();
	} finally {
		ext.permissions.request = original;
		error.element.remove();
	}
	const proseOnly = new ToolCard("fetch", { url: details.access.url });
	proseOnly.setResult("No access to denied.example: network error", true);
	const uncoded = new ToolCard("fetch", { url: details.access.url });
	uncoded.setResult("No access to denied.example", true, details, [{ severity: "error", code: "tool_error", message: "No access to denied.example" }]);
	const noUrl = new ToolCard("fetch", { url: details.access.url });
	noUrl.setResult("Permission required.", true, undefined, diagnostics);
	const unsafeUrl = new ToolCard("fetch", {});
	unsafeUrl.setResult("Permission required.", true, { access: { url: "file:///private.txt" } }, diagnostics);
	const success = new ToolCard("fetch", {});
	success.setResult("Permission required.", false, details, diagnostics);
	const gated = [proseOnly, uncoded, noUrl, unsafeUrl, success].every((card) => !card.element.querySelector(".tool-grant"));
	const metaOf = (card: ToolCard) => card.element.querySelector(".tool-meta")?.textContent;
	const fetched = new ToolCard("fetch", {});
	fetched.setResult("Downloaded (no HTTP summary).", false, { http: { status: 201, bytes: 1536 } });
	const httpMeta = metaOf(fetched);
	fetched.setResult("HTTP 200 OK · text/plain · 999 bytes", false);
	const legacyHttpIgnored = metaOf(fetched) === "";
	fetched.setResult("HTTP 200 OK · text/plain · 999 bytes", false, { http: { status: "200", bytes: -1 } });
	const malformedHttpIgnored = metaOf(fetched) === "";
	const snapshot = new ToolCard("page_snapshot", {});
	const snapshotText = JSON.stringify({ title: "Output title", elements: [] });
	snapshot.setResult(snapshotText, false, { snapshot: { title: "UI title", elementCount: 3 } });
	const snapshotMeta = metaOf(snapshot);
	snapshot.setResult(snapshotText, false);
	const legacySnapshotIgnored = metaOf(snapshot) === "";
	const inspect = new ToolCard("page_inspect", { selector: ".item" });
	const inspectArgs = metaOf(inspect);
	inspect.setResult("{}", false, { inspect: { matched: 30, shown: 5 } });
	const inspectMeta = metaOf(inspect);

	const transcript = new Transcript({ suggest: () => {}, openSettings: () => {}, chooseModel: () => {}, readFile: async () => new Uint8Array(), retry: async () => undefined, allowed: () => {} });
	const conversationId = ROOT_CONVERSATION_ID;
	const entries: EntryRecord[] = [{
		id: 1 as EntryId, conversationId, kind: "pi.assistant",
		model: [fauxAssistantMessage([
			fauxToolCall("fetch", { url: "https://args.example/" }, { id: "fetched" }),
			fauxToolCall("fetch", { url: "https://args.example/" }, { id: "denied" }),
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
		transcript.update({ kind: "conversation", view, ready: true });
		const running = transcript.element.querySelector<HTMLDetailsElement>(".tool")!;
		const wasRunning = running.dataset.status === "running";
		entries.push({
			id: 2 as EntryId, conversationId, kind: "pi.tool-result", data: { diagnostics: [] },
			model: [{ role: "toolResult", toolCallId: "fetched", toolName: "fetch", content: [{ type: "text", text: "Done." }],
				details: { http: { status: 206, bytes: 2048 } }, isError: false, timestamp: 0 }],
		}, ...["denied", "orphan"].map((toolCallId, index): EntryRecord => ({
			id: (3 + index) as EntryId, conversationId, kind: "pi.tool-result", data: { diagnostics },
			model: [{ role: "toolResult", toolCallId, toolName: "fetch", content: [{ type: "text", text: "Permission required." }],
				details, isError: true, timestamp: 0 }],
		})));
		transcript.update({ kind: "conversation", view: { ...view, docs: {} }, ready: true });
		const rendered = [...transcript.element.querySelectorAll<HTMLDetailsElement>(".tool")];
		forwarded = wasRunning && rendered.length === 3 && rendered[0] === running && running.dataset.status === "done"
			&& running.querySelector(".tool-meta")?.textContent === "HTTP 206 · 2 KiB"
			&& rendered.slice(1).every((card) => card.dataset.status === "error" && Boolean(card.querySelector(".tool-grant")));
	} finally {
		transcript.clear();
		transcript.element.remove();
	}
	return [
		{ name: "file tools have labeled, specialized cards", ok: labels.every((label, i) => Boolean(label) && label !== names[i]), detail: labels.join(", ") },
		{
			name: "fetch grant requests permission synchronously from details, without a port in its pattern",
			ok: synchronous && JSON.stringify(requests) === JSON.stringify([{ origins: ["https://denied.example/*"] }]) && button?.disabled === true && !error.element.open,
			detail: JSON.stringify(requests),
		},
		{ name: "access grants require an error, no_access code and safe URL details, never prose", ok: gated },
		{ name: "fetch metadata uses details and ignores legacy prose or malformed details", ok: httpMeta === "HTTP 201 · 1.5 KiB" && legacyHttpIgnored && malformedHttpIgnored, detail: httpMeta },
		{ name: "inspect cards show the target, then how many elements were shown", ok: inspectArgs === ".item" && inspectMeta === t("tool.inspected", 5, 30), detail: inspectMeta },
		{ name: "snapshot metadata uses details, not model-facing JSON", ok: snapshotMeta === `UI title · ${t("tool.elements", 3)}` && legacySnapshotIgnored, detail: snapshotMeta },
		{ name: "Transcript forwards result details and diagnostics to running and orphaned cards", ok: forwarded },
	];
}
