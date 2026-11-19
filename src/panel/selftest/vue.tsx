import { createApp, defineComponent, h as vueH, nextTick, shallowRef } from "vue";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationView, type EntryId, type EntryRecord, type LiveState, ROOT_CONVERSATION_ID, type RunFailure, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { BusyMode } from "../../contracts/chat.ts";
import { SendModeMenu, StopConfirmMenu } from "../menus.tsx";
import { Overlays } from "../overlay.ts";
import { OverlayHost } from "../overlay-host.tsx";
import type { PanelController } from "../controller.ts";
import { t } from "../i18n/index.ts";
import { h } from "../ui.ts";
import { until } from "./dom.ts";
import { QueueFixture, TranscriptFixture } from "./fixtures.tsx";

type Step = (name: string, ok: boolean, detail?: string) => void;
const actions = { suggest: () => {}, openSettings: () => {}, chooseModel: () => {}, readFile: async () => new Uint8Array(), retry: async () => undefined };

export async function testVueComponents(fixture: HTMLElement, step: Step, escape: () => void) {
	const overlays = new Overlays();
	const host = document.createElement("div");
	fixture.append(host);
	const app = createApp({ render: () => vueH(OverlayHost, { overlays }) });
	app.mount(host);
	const firstTrigger = h("button", null, "drawer trigger");
	const secondTrigger = h("button", null, "menu trigger");
	fixture.append(firstTrigger, secondTrigger);
	const makeView = () => defineComponent({
		setup() {
			return () => vueH("div", [vueH("button", "first"), vueH("button", "last")]);
		},
	});
	try {
		overlays.open({ id: "chats", kind: "drawer", anchor: firstTrigger, component: makeView() });
		await nextTick();
		const root = document.querySelector<HTMLElement>(".drawer-overlay")!;
		const focusable = [...root.querySelectorAll<HTMLButtonElement>(".drawer-overlay button")].filter((button) => button !== firstTrigger);
		focusable.at(-1)!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		const wrappedForward = document.activeElement === focusable[0];
		focusable[0]!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
		step("modal overlays receive focus and trap both Tab directions", root.querySelector("[aria-modal='true']") !== null && wrappedForward && document.activeElement === focusable.at(-1),
			JSON.stringify({ wrappedForward, active: document.activeElement?.outerHTML?.slice(0, 220), buttons: focusable.map((button) => button.textContent) }));
		const backdrop = root.querySelector<HTMLElement>(".backdrop")!;
		overlays.open({ id: "model", kind: "popover", anchor: secondTrigger, component: makeView() });
		await nextTick();
		backdrop.click();
		step("a retiring backdrop cannot close the replacement overlay", overlays.current.value?.id === "model");
		escape();
		overlays.close();
		step("overlay close is idempotent and restores trigger focus", !overlays.current.value && document.activeElement === secondTrigger);
		overlays.open({ id: "model", kind: "popover", anchor: secondTrigger, component: makeView() });
		await nextTick();
		secondTrigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		const kept = overlays.current.value?.id === "model";
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		step("popover outside dismissal excludes its trigger", kept && !overlays.current.value);

		const transcript = new TranscriptFixture(actions);
		fixture.append(transcript.element);
		await transcript.update({ kind: "loading" });
		const loading = Boolean(transcript.element.querySelector(".connecting"));
		await transcript.update({ kind: "empty", ready: false });
		const setup = Boolean(transcript.element.querySelector(".setup"));
		await transcript.update({ kind: "empty", ready: true });
		step("Transcript represents loading and new-chat states explicitly", loading && setup && transcript.element.querySelectorAll(".suggestion").length === 3);
		const conversationId = ROOT_CONVERSATION_ID;
		const entries: EntryRecord[] = [
			{ id: 1 as EntryId, conversationId, kind: "pi.user", model: [{ role: "user", content: "Read this file", timestamp: 0 }] },
			{ id: 2 as EntryId, conversationId, kind: "pi.assistant", model: [fauxAssistantMessage(fauxToolCall("read", { path: "notes.txt" }, { id: "call-1" }))] },
		];
		const partial = fauxAssistantMessage("Working");
		const live: LiveState = {
			run: { taskId: 1 as TaskId, inputs: [], turns: 0 },
			generation: { attempt: 1, message: {
				role: "assistant", content: [{ type: "text", text: "Working" }], api: partial.api, provider: partial.provider,
				model: partial.model, usage: partial.usage, stopReason: partial.stopReason, timestamp: partial.timestamp,
			} },
			tools: [{ callId: "call-1", name: "read", status: "running", output: "Reading" }],
		};
		const view: ConversationView = { conversation: { id: conversationId }, entries, docs: { "pi.live": live } };
		await transcript.update({ kind: "conversation", view, ready: true });
		const user = transcript.element.querySelector(".msg.user");
		const copy = user?.querySelector<HTMLButtonElement>(".msg-actions button");
		copy?.focus();
		transcript.controller.store.forking.value = true;
		await nextTick();
		step("user message actions preserve the focused copy button while a fork is pending",
			Boolean(copy) && user?.querySelector(".msg-actions button") === copy && document.activeElement === copy);
		transcript.controller.store.forking.value = false;
		const card = transcript.element.querySelector<HTMLElement>(".tool")!;
		const running = transcript.busy && card.dataset.status === "running" && Boolean(transcript.element.querySelector(".msg[data-live]"));
		const result: EntryRecord = { id: 3 as EntryId, conversationId, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "File contents" }], isError: false, timestamp: 0 }] };
		await transcript.update({ kind: "conversation", view: { ...view, entries: [...entries, result], docs: {} }, ready: true });
		step("canonical Durable state preserves incremental rows and tool settlement", running && !transcript.busy && card.dataset.status === "done" && transcript.element.querySelector(".msg.user") === user && card.textContent?.includes("File contents") === true);
		const failure: RunFailure = { taskId: 1 as TaskId, inputs: [], reason: "restart_limit", detail: "Retry exhausted" };
		await transcript.update({ kind: "conversation", view: { ...view, entries: [...entries, result], docs: { "pi.live": { runFailure: failure } } }, ready: true });
		step("all upstream failure reasons remain renderable", transcript.element.querySelector<HTMLElement>(".notice")?.dataset.reason === "restart_limit");
		const failed = fauxAssistantMessage("", { stopReason: "error", errorMessage: `500: {"message":"The server had an error while processing your request","type":"server_error"}` });
		const failedEntry: EntryRecord = { id: 4 as EntryId, conversationId, kind: "pi.assistant", model: [failed] };
		const retrying: LiveState = { run: { taskId: 1 as TaskId, inputs: [], turns: 0 }, generation: { attempt: 2, retry: { at: Date.now() + 60_000, error: failed.errorMessage! } } };
		await transcript.update({ kind: "conversation", view: { ...view, entries: [...entries, result, failedEntry], docs: { "pi.live": retrying } }, ready: true });
		const retryNotices = [...transcript.element.querySelectorAll<HTMLElement>(".notice")];
		step("a pending retry reuses the failed answer's notice instead of adding a retry row and typing indicator",
			retryNotices.length === 1 && retryNotices[0]?.dataset.tone === "warn" && Boolean(retryNotices[0]?.querySelector(".notice-retry")) && !transcript.element.querySelector(".typing"),
			JSON.stringify(retryNotices.map((notice) => notice.outerHTML.slice(0, 160))));
		const failedAgain: EntryRecord = { id: 5 as EntryId, conversationId, kind: "pi.assistant", model: [failed] };
		const modelFailure: RunFailure = { taskId: 1 as TaskId, inputs: [], reason: "model_error", detail: failed.errorMessage };
		await transcript.update({ kind: "conversation", view: { ...view, entries: [...entries, result, failedEntry, failedAgain], docs: { "pi.live": { runFailure: modelFailure } } }, ready: true });
		const failureNotices = [...transcript.element.querySelectorAll<HTMLElement>(".notice")];
		step("a final model failure collapses the entry and run failure into one notice",
			failureNotices.length === 2 && transcript.element.querySelectorAll(".notice-recovered").length === 1 && Boolean(transcript.element.querySelector(".notice[data-reason='model_error'] #retry")),
			JSON.stringify(failureNotices.map((notice) => notice.dataset.reason)));
		const answered: EntryRecord = { id: 6 as EntryId, conversationId, kind: "pi.assistant", model: [fauxAssistantMessage("Recovered answer")] };
		await transcript.update({ kind: "conversation", view: { ...view, entries: [...entries, result, failedEntry, failedAgain, answered], docs: {} }, ready: true });
		step("consecutive retried errors collapse into one counted line that reopens",
			transcript.element.querySelectorAll(".notice-recovered").length === 1 && transcript.element.querySelectorAll(".notice").length === 1
				&& transcript.element.querySelector(".notice-recovered-label")?.textContent?.includes(t("error.retriedTimes", 2)) === true,
			transcript.element.querySelector(".notice-recovered-label")?.textContent);
		await transcript.update({ kind: "empty", ready: true });
		step("switching to a new chat clears committed rows and cards", !transcript.element.querySelector(".msg, .tool") && !transcript.busy);
		transcript.dispose();

		const paged = new TranscriptFixture(actions);
		fixture.append(paged.element);
		const lateResult: EntryRecord = { id: 6 as EntryId, conversationId, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "late-call", toolName: "read", content: [{ type: "text", text: "Late result" }], isError: false, timestamp: 0 }] };
		await paged.update({ kind: "conversation", ready: true, view: { conversation: { id: conversationId }, entries: [lateResult], docs: {} } });
		await paged.update({ kind: "conversation", ready: true, view: { conversation: { id: conversationId }, entries: [
			{ id: 5 as EntryId, conversationId, kind: "pi.assistant", model: [fauxAssistantMessage(fauxToolCall("read", { path: "late.txt" }, { id: "late-call" }))] }, lateResult,
		], docs: {} } });
		step("loading an older call adopts its previously orphaned result", paged.element.querySelectorAll(".tool").length === 1
			&& paged.element.querySelector(".msg.assistant .tool")?.textContent?.includes("Late result") === true);
		paged.dispose();

		const changes: { id: number; text?: string; whenBusy?: string }[] = [];
		const cancelled: number[] = [];
		let continuations = 0;
		const queue = new QueueFixture({
			update: async (id, change) => { changes.push({ id, ...change }); return "updated"; },
			cancel: async (id) => { cancelled.push(id); return "aborted"; }, continue: async () => { continuations++; },
		});
		fixture.append(queue.element);
		const queuedView: ConversationView = { ...view, docs: { "pi.live": live, "pi.inbox": { items: [
			{ id: 11 as SubmissionId, mode: "steer", content: "Queued steer" }, { id: 12 as SubmissionId, mode: "followUp", content: "Queued follow-up" },
		] } } };
		await queue.update(queuedView);
		step("inbox projection renders both delivery modes", queue.count === 2 && queue.element.querySelectorAll(".queue-item").length === 2 && !queue.element.querySelector(".queue-continue"));
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] [data-action="mode"]')!.click();
		await until(() => changes.length === 1);
		const changedMode: ConversationView = { ...queuedView, docs: { ...queuedView.docs, "pi.inbox": { items: [
			{ id: 11 as SubmissionId, mode: "followUp", content: "Queued steer" }, { id: 12 as SubmissionId, mode: "followUp", content: "Queued follow-up" },
		] } } };
		await queue.update(changedMode);
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="12"] .queue-edit')!.click();
		await nextTick();
		const editor = queue.element.querySelector<HTMLTextAreaElement>("[data-submission-id='12'] .queue-editor")!;
		editor.value = "Edited follow-up";
		editor.dispatchEvent(new Event("input"));
		await queue.update(changedMode);
		const unchangedEditor = queue.element.querySelector("[data-submission-id='12'] .queue-editor") === editor && editor.value === "Edited follow-up";
		editor.focus();
		editor.setSelectionRange(4, 7);
		const changedDuringEdit: ConversationView = { ...changedMode, docs: { ...changedMode.docs, "pi.inbox": { items: [
			{ id: 11 as SubmissionId, mode: "followUp", content: "Queued steer" }, { id: 12 as SubmissionId, mode: "followUp", content: "Queued follow-up" },
			{ id: 13 as SubmissionId, mode: "followUp", content: "New while editing" },
		] } } };
		await queue.update(changedDuringEdit);
		const rebuiltEditor = queue.element.querySelector<HTMLTextAreaElement>("[data-submission-id='12'] .queue-editor")!;
		const preservedEditor = unchangedEditor && rebuiltEditor === editor && document.activeElement === rebuiltEditor && rebuiltEditor.selectionStart === 4 && rebuiltEditor.selectionEnd === 7;
		queue.element.querySelector<HTMLSelectElement>("[data-submission-id='12'] .queue-edit-mode")!.value = "steer";
		queue.element.querySelector<HTMLSelectElement>("[data-submission-id='12'] .queue-edit-mode")!.dispatchEvent(new Event("change"));
		queue.element.querySelector<HTMLButtonElement>("[data-submission-id='12'] .queue-save")!.click();
		await until(() => changes.length === 2);
		step("queue edits preserve drafts and submit atomically", changes[0]?.id === 11 && changes[0]?.whenBusy === "followUp" && preservedEditor && changes[1]?.id === 12 && changes[1]?.text === "Edited follow-up" && changes[1]?.whenBusy === "steer");
		await until(() => !queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] .queue-cancel')!.disabled);
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] .queue-cancel')!.click();
		await until(() => cancelled.length === 1);
		await until(() => !queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] .queue-edit')!.disabled);
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] .queue-edit')!.click();
		const previousToasts = new Set(document.querySelectorAll(".toast"));
		await queue.update({ ...changedMode, docs: { "pi.live": { runFailure: failure }, "pi.inbox": { items: [{ id: 12 as SubmissionId, mode: "steer", content: "Edited follow-up" }] } } });
		const lossNotice = [...document.querySelectorAll(".toast")].some((node) => !previousToasts.has(node) && node.textContent === t("queue.unavailable"));
		queue.element.querySelector<HTMLButtonElement>(".queue-continue")!.click();
		await until(() => continuations === 1);
		step("failed runs expose continuation and removed edits warn without losing state", cancelled[0] === 11 && continuations === 1 && queue.count === 1 && lossNotice && !queue.element.querySelector(".queue-editor"));
		await queue.update(null);
		step("switching chats clears the inbox projection", queue.count === 0 && queue.hidden);
		queue.dispose();

		let picked = "";
		const menuController = {
			store: { busyMode: shallowRef<BusyMode>("followUp") }, overlays: { close: () => {} }, composer: { focus: () => {} },
			session: { setBusyMode: async (mode: BusyMode) => { picked = mode; } },
		} as unknown as PanelController;
		const menuHost = h("div");
		fixture.append(menuHost);
		const menuApp = createApp({ render: () => vueH(SendModeMenu, { controller: menuController }) });
		menuApp.mount(menuHost);
		await nextTick();
		menuHost.firstElementChild!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		const keyboardMode = (document.activeElement as HTMLElement)?.dataset.mode;
		(document.activeElement as HTMLButtonElement).click();
		await nextTick();
		const radio = menuHost.querySelector('[data-mode="steer"]')?.getAttribute("aria-checked");
		step("delivery menu supports arrow keys and radio state", keyboardMode === "steer" && picked === "steer" && radio === "false", JSON.stringify({ keyboardMode, picked, radio }));
		menuApp.unmount();

		let stopConfirmed = false;
		const stopHost = h("div");
		fixture.append(stopHost);
		const stopApp = createApp({ render: () => vueH(StopConfirmMenu, { controller: menuController, count: 2, confirm: () => { stopConfirmed = true; } }) });
		stopApp.mount(stopHost);
		await nextTick();
		const safeFocus = document.activeElement === stopHost.querySelector(".queue-stop-cancel");
		stopHost.querySelector<HTMLButtonElement>(".queue-stop-confirm")!.click();
		step("stop confirmation uses overlay controls with safe initial focus", safeFocus && stopConfirmed);
		stopApp.unmount();

		const modeButton = h("button", { class: "send-mode-btn", type: "button" });
		const sendButton = h("button", { class: "send-btn", type: "button" });
		fixture.append(h("div", { class: "composer-bar" }, h("button", { class: "send-btn stop-btn", type: "button" }), modeButton, sendButton));
		step("visible stop and delivery controls do not split the remaining space", getComputedStyle(modeButton).marginLeft === "0px" && getComputedStyle(sendButton).marginLeft === "0px");
	} finally {
		overlays.close(false);
		app.unmount();
		host.remove();
		firstTrigger.remove();
		secondTrigger.remove();
	}
}
