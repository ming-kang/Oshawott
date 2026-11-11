import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationView, type EntryId, type EntryRecord, type LiveState, ROOT_CONVERSATION_ID, type RunFailure, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { OverlayController, type OverlayView } from "./overlays.ts";
import { t } from "./i18n.ts";
import { testAccountLogin } from "./login-selftest.ts";
import { pickBuiltin, testModelManagement } from "./model-selftest.ts";
import { MessageQueue, SendModeMenu, StopConfirmMenu } from "./queue.ts";
import { Transcript } from "./render.ts";
import { h } from "./ui.ts";

type Step = { name: string; ok: boolean; detail?: string };
type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"chats" | "createChat" | "deleteChat" | "renameChat" | "busyMode" | "setBusyMode" | "providers" | "defaultModel" | "setDefaultConfiguration"
	| "autoTitle" | "autoCompaction" | "autoRetry" | "confirmActions" | "setPreference"
	| "instructions" | "setInstructions" | "resetInstructions" | "logins" | "logout"
>;
async function until(read: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("panel control did not settle");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
const click = (selector: string) => {
	const element = document.querySelector<HTMLElement>(`.overlay:not(.leaving) ${selector}`) ?? document.querySelector<HTMLElement>(selector);
	if (!element) throw new Error(`No panel control ${selector}`);
	element.click();
};

export async function testPanel(source: Source, origin?: string) {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, detail });
	const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

	// These keys are only saved and cleared locally; all model requests still use the demo provider.
	click("#settings-toggle");
	step("settings opens as a named modal and receives focus", document.querySelector("#settings")?.getAttribute("aria-modal") === "true" && document.activeElement?.id === "settings-back" && document.querySelector("#settings-back")?.hasAttribute("aria-label") === true);
	const savedRows = [...document.querySelectorAll<HTMLElement>(".provider[data-provider]")];
	step("settings lists only saved providers as text rows", savedRows.length > 0 && savedRows.every((row) => {
		const provider = source.providers.value.find((item) => item.id === row.dataset.provider);
		return (provider?.kind === "custom" || provider?.configured === true) && !row.querySelector(".provider-mark");
	}), savedRows.map((row) => row.dataset.provider).join(", "));
	click("#add-provider");
	const options = () => [...document.querySelectorAll<HTMLElement>("#builtin-provider-list [data-provider]")].map((option) => option.dataset.provider);
	const providerSearch = document.querySelector<HTMLInputElement>("#builtin-provider-search")!;
	step("a built-in provider must be chosen before its key field or Save appear", options().length > 1
		&& document.querySelector<HTMLElement>("#provider-key")?.closest<HTMLElement>(".provider-field")?.hidden === true
		&& document.querySelector<HTMLElement>("#provider-save")?.hidden === true);
	step("well-known built-in providers are listed first", options()[0] === "anthropic", options().slice(0, 4).join(","));
	providerSearch.value = "groq";
	providerSearch.dispatchEvent(new Event("input", { bubbles: true }));
	step("the built-in provider search filters by name", options().includes("groq") && !options().includes("anthropic"), options().join(","));
	await pickBuiltin("groq");
	step("the built-in provider list reveals additional Pi-AI providers", document.querySelector("#builtin-provider-chosen .provider-chosen-name")?.textContent === "Groq"
		&& document.querySelector<HTMLElement>(".provider-picker")?.hidden === true
		&& !document.querySelector('.provider[data-provider="groq"]'));
	click("#provider-kind-custom");
	const customOrder = [...document.querySelectorAll(".provider-editor-form .provider-field > :last-child")].map((field) => field.id);
	step("custom fields and model sections follow the requested order", customOrder.join(",") === "provider-name,provider-base-url,provider-api,provider-key"
		&& document.querySelector("#provider-discovery")!.compareDocumentPosition(document.querySelector("#provider-custom-models")!) === Node.DOCUMENT_POSITION_FOLLOWING);
	click("#provider-kind-builtin");
	click("#builtin-provider-change");
	await pickBuiltin("anthropic");
	const input = document.querySelector<HTMLInputElement>("#provider-key")!;
	input.value = "panel-smoke-key";
	click("#provider-save");
	await until(() => source.providers.value.find((provider) => provider.id === "anthropic")?.configured === true
		&& Boolean(document.querySelector('.provider[data-provider="anthropic"] .pill[data-on]')));
	step("saving a built-in provider adds a configured text row", !document.querySelector('.provider[data-provider="anthropic"] .provider-mark'));
	click('.provider[data-provider="anthropic"] .provider-head');
	step("settings refresh after saving a key without exposing it", document.querySelector<HTMLInputElement>("#provider-key")?.value === "");
	click("#provider-delete");
	await until(() => source.providers.value.find((provider) => provider.id === "anthropic")?.configured === false
		&& !document.querySelector('.provider[data-provider="anthropic"]'));
	step("removing a built-in key hides its row", true);
	const defaultDelivery = source.busyMode.value === "steer" && document.querySelector('#settings-delivery [data-value="steer"]')?.getAttribute("aria-checked") === "true";
	click('#settings-delivery [data-value="followUp"]');
	await until(() => source.busyMode.value === "followUp" && document.querySelector<HTMLElement>("#send-mode")?.dataset.mode === "followUp");
	step("delivery defaults to Steer and Settings updates the composer preference", defaultDelivery && document.querySelector('#settings-delivery [data-value="followUp"]')?.getAttribute("aria-checked") === "true");
	click('#settings-delivery [data-value="steer"]');
	await until(() => source.busyMode.value === "steer" && document.querySelector<HTMLElement>("#send-mode")?.dataset.mode === "steer");
	const defaultTitlePreference = source.autoTitle.value === false && !document.querySelector<HTMLInputElement>("#settings-autoTitle")?.checked;
	click("#settings-autoTitle");
	await until(() => source.autoTitle.value && document.querySelector<HTMLInputElement>("#settings-autoTitle")?.checked === true);
	click("#settings-autoTitle");
	await until(() => !source.autoTitle.value);
	click("#settings-autoCompaction");
	await until(() => !source.autoCompaction.value);
	click("#settings-autoRetry");
	await until(() => !source.autoRetry.value);
	click("#settings-autoCompaction");
	await until(() => source.autoCompaction.value);
	click("#settings-autoRetry");
	await until(() => source.autoRetry.value);
	step("conversation preferences default safely and round-trip through native checkboxes", defaultTitlePreference && source.autoCompaction.value && source.autoRetry.value);
	const defaultConfirm = !source.confirmActions.value && !document.querySelector<HTMLInputElement>("#settings-confirmActions")?.checked;
	click("#settings-confirmActions");
	await until(() => source.confirmActions.value && document.querySelector<HTMLInputElement>("#settings-confirmActions")?.checked === true);
	click("#settings-confirmActions");
	await until(() => !source.confirmActions.value);
	step("asking before page actions is off by default and round-trips through its checkbox", defaultConfirm);
	const originalInstructions = source.instructions.value;
	const instructions = document.querySelector<HTMLTextAreaElement>("#settings-instructions")!;
	const details = document.querySelector<HTMLDetailsElement>("#settings-instructions-details")!;
	step("global instructions start collapsed with a one-line preview", !details.open && details.contains(instructions)
		&& Boolean(document.querySelector("#settings-instructions-preview")?.textContent));
	details.open = true;
	instructions.value = "Panel smoke unsaved instructions";
	instructions.dispatchEvent(new Event("input", { bubbles: true }));
	await source.setInstructions({ instructions: "Other panel instructions" }, BACKGROUND_CONTEXT);
	await until(() => document.querySelector<HTMLElement>("#settings-instructions-status")?.hidden === false);
	step("external instructions changes preserve unsaved edits and offer an accessible reload", instructions.value === "Panel smoke unsaved instructions"
		&& document.querySelector("#settings-instructions-status")?.getAttribute("role") === "status"
		&& document.querySelector("#settings-instructions-status")?.textContent?.includes(t("settings.instructionsChangedElsewhere")) === true);
	click("#instructions-load-latest");
	step("loading the latest instructions explicitly discards the local draft", instructions.value === "Other panel instructions" && document.querySelector<HTMLElement>("#settings-instructions-status")?.hidden === true);
	instructions.value = "Panel smoke instructions";
	instructions.dispatchEvent(new Event("input", { bubbles: true }));
	click("#instructions-save");
	await until(() => source.instructions.value === "Panel smoke instructions" && document.querySelector<HTMLButtonElement>("#instructions-save")?.disabled === false);
	click("#instructions-restore");
	click("#instructions-restore");
	await until(() => source.instructions.value === originalInstructions && instructions.value === originalInstructions);
	step("global instructions save and restore without clobbering their editor", true);
	instructions.value = " \n\t ";
	instructions.dispatchEvent(new Event("input", { bubbles: true }));
	click("#instructions-save");
	await until(() => source.instructions.value === originalInstructions && instructions.value === originalInstructions && document.querySelector<HTMLButtonElement>("#instructions-save")?.disabled === false);
	step("whitespace-only instructions saves settle to the built-in text", true);
	const theme = document.documentElement.dataset.theme ?? "system";
	click('#settings [data-value="dark"]');
	step("appearance stays owned by Settings", document.documentElement.dataset.theme === "dark" && document.querySelector('#settings [data-value="dark"]')?.getAttribute("aria-checked") === "true");
	document.querySelector('#settings [data-value="dark"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
	step("appearance radios support arrow keys and roving focus", document.documentElement.dataset.theme === "system" && (document.activeElement as HTMLElement)?.dataset.value === "system" && document.querySelector('#settings [data-value="system"]')?.getAttribute("aria-checked") === "true");
	click(`#settings [data-value="${theme}"]`);
	const languages = [...document.querySelectorAll<HTMLElement>("#settings-language [data-value]")];
	step("settings offers system language, Chinese and English with the current preference selected", languages.map((item) => item.dataset.value).join(",") === "system,zh-CN,en"
		&& languages.slice(1).map((item) => item.textContent).join(",") === "中文,English"
		&& languages.filter((item) => item.getAttribute("aria-checked") === "true").length === 1);
	click("#settings-back");
	await until(() => !document.querySelector("#settings"));

	click("#chats-toggle");
	step("chat rows are buttons inside a focus-managed dialog", document.querySelector("#chat-drawer")?.getAttribute("role") === "dialog" && document.querySelector(".chat-select") instanceof HTMLButtonElement && document.querySelector("#chat-drawer")?.contains(document.activeElement) === true);
	const renamedId = source.chats.value[0]?.id;
	const originalTitle = source.chats.value[0]?.title ?? "";
	const renamedRow = document.querySelector(`.chat-item[data-id="${renamedId}"]`);
	click(`.chat-item[data-id="${renamedId}"] [data-action="rename"]`);
	const rename = document.querySelector<HTMLInputElement>(".rename-input")!;
	rename.value = "Panel smoke title";
	rename.dispatchEvent(new Event("input", { bubbles: true }));
	rename.focus();
	rename.setSelectionRange(6, 11);
	const resetId = await source.createChat({ title: "Panel smoke reset" }, BACKGROUND_CONTEXT);
	await until(() => document.querySelector(`.chat-item[data-id="${resetId}"] [data-action="reset"]`) !== null);
	await source.renameChat({ id: resetId, title: "Panel smoke reset updated" }, BACKGROUND_CONTEXT);
	await until(() => document.querySelector(`.chat-item[data-id="${resetId}"] .chat-title`)?.textContent === "Panel smoke reset updated");
	step("live chat updates preserve row identity, rename drafts and the caret", document.querySelector(`.chat-item[data-id="${renamedId}"]`) === renamedRow
		&& document.querySelector(".rename-input") === rename && rename.value === "Panel smoke title"
		&& document.activeElement === rename && rename.selectionStart === 6 && rename.selectionEnd === 11);
	click('[data-action="save"]');
	await until(() => source.chats.value.find((chat) => chat.id === renamedId)?.title === "Panel smoke title" && !document.querySelector(".rename-input"));
	await source.renameChat({ id: renamedId!, title: originalTitle }, BACKGROUND_CONTEXT);
	step("chat titles can be edited inline without leaving the drawer", document.querySelector("#chat-drawer") !== null);
	const reset = document.querySelector<HTMLButtonElement>(`.chat-item[data-id="${resetId}"] [data-action="reset"]`)!;
	click(`.chat-item[data-id="${resetId}"] [data-action="reset"]`);
	const requiresConfirm = reset.hasAttribute("data-confirm") && !reset.disabled;
	click(`.chat-item[data-id="${resetId}"] [data-action="reset"]`);
	await until(() => !reset.disabled);
	step("resetting a background chat keeps its row and focus-managed controls", source.chats.value.some((chat) => chat.id === resetId));
	step("reset requires confirmation and restores its icon after completion", requiresConfirm && !reset.hasAttribute("data-confirm") && Boolean(reset.querySelector("svg"))
		&& document.querySelector(`.chat-item[data-id="${resetId}"] [data-action="reset"]`) === reset);
	click(`.chat-item[data-id="${resetId}"] [data-action="rename"]`);
	await source.deleteChat({ id: resetId }, BACKGROUND_CONTEXT);
	await until(() => !document.querySelector(`.chat-item[data-id="${resetId}"]`));
	step("a renamed chat removed elsewhere drops its draft and focuses a surviving control", !document.querySelector(".rename-input")
		&& Boolean(document.activeElement?.matches(".chat-select, #chat-drawer .panel-head button")));
	escape();
	await until(() => !document.querySelector("#chat-drawer"));

	click("#model");
	const search = document.querySelector<HTMLInputElement>("#model-menu input")!;
	search.value = "demo";
	search.dispatchEvent(new Event("input"));
	const choices = [...document.querySelectorAll<HTMLElement>("#model-menu .menu-item")];
	step("model menu filters the shared provider state", choices.length > 0 && choices.every((item) => item.dataset.provider === "demo"));
	step("model combobox exposes its active option", choices.every((item) => item.tabIndex === -1) && search.getAttribute("aria-activedescendant") === choices.find((item) => item.classList.contains("active"))?.id);
	search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	await until(() => !document.querySelector("#model-menu"));
	click("#model");
	click("#settings-toggle");
	step("opening a sheet replaces the model menu", !document.querySelector("#model-menu") && document.querySelectorAll(".overlay:not(.leaving)").length === 1);
	escape();
	step("Escape restores the active overlay's trigger focus", document.activeElement?.id === "settings-toggle" && !document.querySelector(".overlay:not(.leaving)"));
	await until(() => !document.querySelector("#settings"));

	const modelIcon = document.querySelector("#model svg");
	const sendIcon = document.querySelector("#send svg");
	const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
	const originalPrompt = prompt.value;
	for (const value of ["first", "second", originalPrompt]) {
		prompt.value = value;
		prompt.dispatchEvent(new Event("input"));
	}
	step("unchanged composer presentation keeps its button subtrees", Boolean(modelIcon && sendIcon) && document.querySelector("#model svg") === modelIcon && document.querySelector("#send svg") === sendIcon);

	click("#files-toggle");
	await until(() => document.querySelector("#files .file-list")?.getAttribute("aria-busy") === "false");
	const list = document.querySelector("#files .file-list")!;
	let refreshes = 0;
	const observer = new MutationObserver((records) => { refreshes += records.length; });
	observer.observe(list, { attributes: true, attributeFilter: ["aria-busy"] });
	let backgroundId: number | undefined;
	try {
		backgroundId = await source.createChat({ title: "Background refresh check" }, BACKGROUND_CONTEXT);
		await until(() => source.chats.value.some((chat) => chat.id === backgroundId));
		await source.deleteChat({ id: backgroundId }, BACKGROUND_CONTEXT);
		await until(() => !source.chats.value.some((chat) => chat.id === backgroundId));
		backgroundId = undefined;
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		step("unrelated workspace changes do not re-query the file sheet", refreshes === 0);
	} finally {
		observer.disconnect();
		if (backgroundId !== undefined) await source.deleteChat({ id: backgroundId }, BACKGROUND_CONTEXT);
		click("#files-back");
		await until(() => !document.querySelector("#files"));
	}

	const fixture = h("div");
	const firstTrigger = h("button", null, "drawer trigger");
	const secondTrigger = h("button", null, "menu trigger");
	fixture.append(firstTrigger, secondTrigger);
	document.body.append(fixture);
	const controller = new OverlayController();
	const retiredRoots: HTMLElement[] = [];
	const makeView = () => {
		let refreshes = 0;
		let closes = 0;
		const element = h("div", null, h("button", null, "first"), h("button", null, "last"));
		const view: OverlayView = { element, refresh: () => { refreshes++; }, close: () => { closes++; } };
		return { view, refreshes: () => refreshes, closes: () => closes };
	};
	try {
		const first = makeView();
		controller.open(first.view, { kind: "drawer", anchor: firstTrigger });
		const focusable = [...first.view.element.querySelectorAll<HTMLButtonElement>("button")];
		focusable.at(-1)!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		const wrappedForward = document.activeElement === focusable[0];
		focusable[0]!.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
		step("modal overlays receive focus and trap both Tab directions", first.view.element.getAttribute("aria-modal") === "true" && wrappedForward && document.activeElement === focusable.at(-1));
		const root = first.view.element.parentElement!;
		retiredRoots.push(root);
		const backdrop = root.querySelector<HTMLElement>(".backdrop")!;
		const second = makeView();
		controller.open(second.view, { kind: "popover", anchor: secondTrigger });
		backdrop.click();
		step("a retiring backdrop cannot close the replacement overlay", first.closes() === 1 && controller.current === second.view && second.refreshes() === 1);
		escape();
		controller.close();
		await controller.refresh();
		step("overlay close is idempotent and retires refresh callbacks", second.closes() === 1 && second.refreshes() === 1 && !controller.current && document.activeElement === secondTrigger);
		const third = makeView();
		controller.open(third.view, { kind: "popover", anchor: secondTrigger });
		secondTrigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		const kept = controller.current === third.view;
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		step("popover outside dismissal excludes its trigger", kept && !controller.current && third.closes() === 1);

		const transcript = new Transcript({ suggest: () => {}, openSettings: () => {}, chooseModel: () => {}, readFile: async () => new Uint8Array(), retry: async () => undefined, allowed: () => {} });
		fixture.append(transcript.element);
		transcript.update({ kind: "loading" });
		const loading = Boolean(transcript.element.querySelector(".connecting"));
		transcript.update({ kind: "empty", ready: false });
		const setup = Boolean(transcript.element.querySelector(".setup"));
		transcript.update({ kind: "empty", ready: true });
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
		transcript.update({ kind: "conversation", view, ready: true });
		const user = transcript.element.querySelector(".msg.user");
		const card = transcript.element.querySelector<HTMLElement>(".tool")!;
		const running = transcript.busy && card.dataset.status === "running" && Boolean(transcript.element.querySelector(".msg[data-live]"));
		const result: EntryRecord = { id: 3 as EntryId, conversationId, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "File contents" }], isError: false, timestamp: 0 }] };
		const finished: ConversationView = { ...view, entries: [...entries, result], docs: {} };
		transcript.update({ kind: "conversation", view: finished, ready: true });
		step("canonical Durable state preserves incremental rows and tool settlement", running && !transcript.busy && card.dataset.status === "done" && transcript.element.querySelector(".msg.user") === user && card.textContent?.includes("File contents") === true);
		const failure: RunFailure = { taskId: 1 as TaskId, inputs: [], reason: "restart_limit", detail: "Retry exhausted" };
		transcript.update({ kind: "conversation", view: { ...finished, docs: { "pi.live": { runFailure: failure } } }, ready: true });
		step("all upstream failure reasons remain renderable", transcript.element.querySelector<HTMLElement>(".notice")?.dataset.reason === "restart_limit");
		transcript.update({ kind: "empty", ready: true });
		step("switching to a new chat clears committed rows and cards", !transcript.element.querySelector(".msg, .tool") && !transcript.busy);

		const changes: { id: number; text?: string; whenBusy?: string }[] = [];
		const cancelled: number[] = [];
		let continuations = 0;
		const queue = new MessageQueue({
			update: async (id, change) => { changes.push({ id, ...change }); return "updated"; },
			cancel: async (id) => { cancelled.push(id); return "aborted"; },
			continue: async () => { continuations++; },
		});
		fixture.append(queue.element);
		const queuedView: ConversationView = { ...view, docs: {
			"pi.live": live,
			"pi.inbox": { items: [
				{ id: 11 as SubmissionId, mode: "steer", content: "Queued steer" },
				{ id: 12 as SubmissionId, mode: "followUp", content: "Queued follow-up" },
			] },
		} };
		queue.update(queuedView);
		step("inbox projection renders both delivery modes", queue.count === 2 && queue.element.querySelectorAll(".queue-item").length === 2 && !queue.element.querySelector(".queue-continue"));
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] [data-action="mode"]')!.click();
		await until(() => changes.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const changedMode: ConversationView = { ...queuedView, docs: { ...queuedView.docs, "pi.inbox": { items: [
			{ id: 11 as SubmissionId, mode: "followUp", content: "Queued steer" },
			{ id: 12 as SubmissionId, mode: "followUp", content: "Queued follow-up" },
		] } } };
		queue.update(changedMode);
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="12"] .queue-edit')!.click();
		const editor = queue.element.querySelector<HTMLTextAreaElement>("[data-submission-id='12'] .queue-editor")!;
		editor.value = "Edited follow-up";
		editor.dispatchEvent(new Event("input"));
		queue.update(changedMode);
		const unchangedEditor = queue.element.querySelector("[data-submission-id='12'] .queue-editor") === editor && editor.value === "Edited follow-up";
		editor.focus();
		editor.setSelectionRange(4, 7);
		const changedDuringEdit: ConversationView = { ...changedMode, docs: { ...changedMode.docs, "pi.inbox": { items: [
			{ id: 11 as SubmissionId, mode: "followUp", content: "Queued steer" },
			{ id: 12 as SubmissionId, mode: "followUp", content: "Queued follow-up" },
			{ id: 13 as SubmissionId, mode: "followUp", content: "New while editing" },
		] } } };
		queue.update(changedDuringEdit);
		const rebuiltEditor = queue.element.querySelector<HTMLTextAreaElement>("[data-submission-id='12'] .queue-editor")!;
		const preservedEditor = unchangedEditor && rebuiltEditor !== editor && rebuiltEditor.value === "Edited follow-up"
			&& document.activeElement === rebuiltEditor && rebuiltEditor.selectionStart === 4 && rebuiltEditor.selectionEnd === 7;
		queue.element.querySelector<HTMLSelectElement>("[data-submission-id='12'] .queue-edit-mode")!.value = "steer";
		queue.element.querySelector<HTMLButtonElement>("[data-submission-id='12'] .queue-save")!.click();
		await until(() => changes.length === 2);
		await new Promise((resolve) => setTimeout(resolve, 0));
		step("queue edits preserve drafts and submit atomically", changes[0]?.id === 11 && changes[0]?.whenBusy === "followUp" && preservedEditor && changes[1]?.id === 12 && changes[1]?.text === "Edited follow-up" && changes[1]?.whenBusy === "steer");
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] .queue-cancel')!.click();
		await until(() => cancelled.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		queue.element.querySelector<HTMLButtonElement>('[data-submission-id="11"] .queue-edit')!.click();
		const previousToasts = new Set(document.querySelectorAll(".toast"));
		const failedQueue: ConversationView = { ...changedMode, docs: {
			"pi.live": { runFailure: failure },
			"pi.inbox": { items: [{ id: 12 as SubmissionId, mode: "steer", content: "Edited follow-up" }] },
		} };
		queue.update(failedQueue);
		const lossNotice = [...document.querySelectorAll(".toast")].some((node) => !previousToasts.has(node) && node.textContent === t("queue.unavailable"));
		queue.element.querySelector<HTMLButtonElement>(".queue-continue")!.click();
		await until(() => continuations === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		step("failed runs expose continuation and removed edits warn without losing state", cancelled[0] === 11 && continuations === 1 && queue.count === 1 && lossNotice && !queue.element.querySelector(".queue-editor"));
		queue.update(null);
		step("switching chats clears the inbox projection", queue.count === 0 && Boolean(queue.element.hidden));

		let picked = "";
		const sendMenu = new SendModeMenu("followUp", (mode) => { picked = mode; });
		fixture.append(sendMenu.element);
		sendMenu.focus();
		sendMenu.element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		const keyboardMode = (document.activeElement as HTMLElement)?.dataset.mode;
		(document.activeElement as HTMLButtonElement).click();
		const radio = sendMenu.element.querySelector('[data-mode="steer"]')?.getAttribute("aria-checked");
		step("delivery menu supports arrow keys and radio state", keyboardMode === "steer" && picked === "steer" && radio === "false", JSON.stringify({ keyboardMode, picked, radio }));

		let stopConfirmed = false;
		const stopMenu = new StopConfirmMenu(2, () => { stopConfirmed = true; }, () => {});
		fixture.append(stopMenu.element);
		stopMenu.focus();
		const safeFocus = document.activeElement === stopMenu.element.querySelector(".queue-stop-cancel");
		stopMenu.element.querySelector<HTMLButtonElement>(".queue-stop-confirm")!.click();
		step("stop confirmation uses overlay controls with safe initial focus", safeFocus && stopConfirmed);

		const stopButton = h("button", { class: "send-btn stop-btn", type: "button" });
		const modeButton = h("button", { class: "send-mode-btn", type: "button" });
		const sendButton = h("button", { class: "send-btn", type: "button" });
		fixture.append(h("div", { class: "composer-bar" }, stopButton, modeButton, sendButton));
		step("visible stop and delivery controls do not split the remaining space", getComputedStyle(modeButton).marginLeft === "0px" && getComputedStyle(sendButton).marginLeft === "0px");
	} finally {
		controller.dispose();
		for (const root of retiredRoots) root.remove();
		fixture.remove();
	}
	if (origin) steps.push(...await testModelManagement(source, origin), ...await testAccountLogin(source));
	return steps;
}
