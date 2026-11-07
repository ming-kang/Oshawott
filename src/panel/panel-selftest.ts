// Dev-only regressions for component ownership, explicit transcript states and the real panel controls.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationView, type EntryId, type EntryRecord, type LiveState, ROOT_CONVERSATION_ID, type RunFailure, type TaskId } from "@earendil-works/pi-durable";
import type { Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { OverlayController, type OverlayView } from "./overlays.ts";
import { Transcript } from "./render.ts";
import { h } from "./ui.ts";

type Step = { name: string; ok: boolean };
type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>, "chats" | "createChat" | "deleteChat">;
async function until(read: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("panel control did not settle");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
const click = (selector: string) => {
	const element = document.querySelector<HTMLElement>(selector);
	if (!element) throw new Error(`No panel control ${selector}`);
	element.click();
};

export async function testPanel(source: Source) {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean) => steps.push({ name, ok });
	const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

	// These keys are only saved and cleared locally; all model requests still use the demo provider.
	click("#settings-toggle");
	click('.provider[data-provider="anthropic"] .provider-head');
	const input = document.querySelector<HTMLInputElement>('.provider[data-provider="anthropic"] input')!;
	input.value = "panel-smoke-key";
	click('.provider[data-provider="anthropic"] .btn.primary');
	await until(() => document.querySelector('.provider[data-provider="anthropic"] .pill')?.hasAttribute("data-on") === true);
	click('.provider[data-provider="anthropic"] .provider-head');
	step("settings refresh after saving a key without exposing it", document.querySelector<HTMLInputElement>('.provider[data-provider="anthropic"] input')?.value === "");
	click('.provider[data-provider="anthropic"] .btn.danger');
	await until(() => document.querySelector('.provider[data-provider="anthropic"] .pill')?.hasAttribute("data-on") === false);
	const theme = document.documentElement.dataset.theme ?? "system";
	click('#settings [data-value="dark"]');
	step("appearance stays owned by Settings", document.documentElement.dataset.theme === "dark" && document.querySelector('#settings [data-value="dark"]')?.getAttribute("aria-checked") === "true");
	click(`#settings [data-value="${theme}"]`);
	click("#settings-back");
	await until(() => !document.querySelector("#settings"));

	click("#model");
	const search = document.querySelector<HTMLInputElement>("#model-menu input")!;
	search.value = "demo";
	search.dispatchEvent(new Event("input"));
	const choices = [...document.querySelectorAll<HTMLElement>("#model-menu .menu-item")];
	step("model menu filters the shared provider state", choices.length > 0 && choices.every((item) => item.dataset.provider === "demo"));
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
		const view: OverlayView = { element: h("div"), refresh: () => { refreshes++; }, close: () => { closes++; } };
		return { view, refreshes: () => refreshes, closes: () => closes };
	};
	try {
		const first = makeView();
		controller.open(first.view, { kind: "drawer", anchor: firstTrigger });
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

		const transcript = new Transcript({ suggest: () => {}, openSettings: () => {}, chooseModel: () => {} });
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
	} finally {
		controller.dispose();
		for (const root of retiredRoots) root.remove();
		fixture.remove();
	}
	return steps;
}
