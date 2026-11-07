// Renders Durable's conversation view (`Chat.view`) into the thread, incrementally. Committed entries never change, so
// each is built once, keyed by its ID; a tool result fills in the card of its call. Only what `pi.live` holds (the
// answer streaming in, running tools, a retry, the last run's failure) is rebuilt on every change. Text is always set
// as text; model Markdown goes through `markdown.ts`, which builds elements, never HTML.
import type { ConversationView } from "@earendil-works/pi-durable";
import { t } from "./i18n.ts";
import { markdown } from "./markdown-dom.ts";
import { ToolCard } from "./tool-card.ts";
import { copyText, h, type IconName, icon, logo } from "./ui.ts";

type Content =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; redacted?: boolean }
	| { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> }
	| { type: "image"; mimeType: string; data: string };
type UserMessage = { role: "user"; content: string | Content[] };
type AssistantMessage = { role: "assistant"; content: Content[]; stopReason?: string; errorMessage?: string };
type ToolResultMessage = { role: "toolResult"; toolCallId: string; toolName: string; content: Content[]; isError: boolean };
type Message = UserMessage | AssistantMessage | ToolResultMessage | { role: "system" };
type Entry = { id: number | string; kind: string; model?: Message[] };

type ToolSlot = { callId: string; name: string; status: "pending" | "running" | "done"; output?: string };
type Live = {
	run?: object;
	generation?: { attempt: number; message?: AssistantMessage; retry?: { at: number; error: string } };
	tools?: ToolSlot[];
	compactions?: unknown[];
	runFailure?: { reason: string; detail?: string };
};

export interface TranscriptActions {
	/** A suggestion of the empty state was picked. */
	suggest(text: string): void;
	openSettings(): void;
	chooseModel(): void;
}

export interface TranscriptState {
	/** Some provider is connected, so a prompt can be answered. */
	readonly ready: boolean;
}

export const EMPTY_VIEW = { entries: [], docs: {} } as unknown as ConversationView;

const textOf = (content: UserMessage["content"] | Content[]) =>
	typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : "")).join("");

function divider(text: string, live = false) {
	return h("div", { class: "divider", "data-live": live || null }, h("span", null, text));
}

function notice(tone: "error" | "warn" | "info", text: string, detail?: string, iconName: IconName = "alert") {
	return h(
		"div",
		{ class: "notice", "data-tone": tone, role: tone === "error" ? "alert" : "status" },
		h("span", { class: "notice-icon" }, icon(iconName, 16)),
		h("div", { class: "notice-body" }, h("div", null, text), detail ? h("div", { class: "notice-detail" }, detail) : null),
	);
}

function copyButton(text: () => string) {
	const button = h("button", { class: "icon-btn small", type: "button", title: t("copy"), "aria-label": t("copy") }, icon("copy", 14));
	button.addEventListener("click", async () => {
		if (!(await copyText(text()))) return;
		button.replaceChildren(icon("check", 14));
		setTimeout(() => button.replaceChildren(icon("copy", 14)), 1200);
	});
	return button;
}

export class Transcript {
	readonly element: HTMLElement;
	readonly #actions: TranscriptActions;
	readonly #nodes = new Map<string, HTMLElement>();
	readonly #cards = new Map<string, ToolCard>();
	readonly #live: HTMLElement;
	#thinkingOpen = false;
	#busy = false;

	constructor(actions: TranscriptActions) {
		this.#actions = actions;
		this.#live = h("div", { class: "live" });
		this.element = h("div", { class: "thread" }, this.#live);
	}

	get busy() {
		return this.#busy;
	}

	clear() {
		for (const node of this.#nodes.values()) node.remove();
		this.#nodes.clear();
		this.#cards.clear();
		this.#live.replaceChildren();
		this.#thinkingOpen = false;
		this.#busy = false;
	}

	/** `null`: the chat's view is not there yet (connecting). */
	update(view: ConversationView | null, state: TranscriptState) {
		if (!view) {
			this.#live.replaceChildren(h("div", { class: "connecting" }, h("span", { class: "spinner" }), t("connecting")));
			return;
		}
		const entries = view.entries as unknown as Entry[];
		const keep = new Set<string>();
		let index = 0;
		let visible = 0;
		for (const entry of entries) {
			const key = String(entry.id);
			keep.add(key);
			if (entry.kind === "pi.user" || entry.kind === "pi.assistant") visible++;
			let node = this.#nodes.get(key);
			if (!node) {
				node = this.#entry(entry);
				this.#nodes.set(key, node);
			}
			const at = this.element.children[index];
			if (at !== node) this.element.insertBefore(node, at ?? this.#live);
			index++;
		}
		for (const [key, node] of this.#nodes) {
			if (keep.has(key)) continue;
			node.remove();
			this.#nodes.delete(key);
		}
		for (const [id, card] of this.#cards) if (!card.element.isConnected) this.#cards.delete(id);

		const live = view.docs["pi.live"] as Live | undefined;
		this.#busy = Boolean(live?.run);
		this.#renderLive(live, visible === 0 && !this.#busy ? state : undefined);
	}

	#entry(entry: Entry): HTMLElement {
		const message = entry.model?.[0];
		switch (entry.kind) {
			case "pi.user":
				return h("div", { class: "msg user" }, h("div", { class: "bubble" }, message?.role === "user" ? textOf(message.content) : ""));
			case "pi.assistant":
				return message?.role === "assistant" ? this.#assistant(message, false) : h("div", { hidden: true });
			case "pi.tool-result": {
				if (message?.role !== "toolResult") return h("div", { hidden: true });
				const text = textOf(message.content);
				const card = this.#cards.get(message.toolCallId);
				if (card) {
					card.setResult(text, message.isError);
					return h("div", { hidden: true });
				}
				// The call itself is before the window: a card of its own.
				const orphan = new ToolCard(message.toolName, {});
				orphan.setResult(text, message.isError);
				return h("div", { class: "msg assistant" }, h("div", { class: "tools" }, orphan.element));
			}
			case "pi.reset":
				return divider(t("divider.reset"));
			case "pi.compaction":
				return divider(t("divider.compaction"));
			default:
				return h("div", { hidden: true });
		}
	}

	#assistant(message: AssistantMessage, live: boolean): HTMLElement {
		const root = h("div", { class: "msg assistant", "data-live": live || null });
		const blocks = message.content ?? [];
		let tools: HTMLElement | undefined;
		blocks.forEach((block, i) => {
			const last = i === blocks.length - 1;
			if (block.type !== "toolCall") tools = undefined;
			if (block.type === "thinking") {
				if (block.redacted || !block.thinking.trim()) return;
				const thinking = live && last;
				const details = h(
					"details",
					{ class: "thinking", "data-live": thinking || null },
					h("summary", null, icon("bulb", 14), h("span", null, thinking ? t("thinking.live") : t("thinking.title")), icon("chevron", 14)),
					markdown(block.thinking),
				) as HTMLDetailsElement;
				if (live) {
					details.open = this.#thinkingOpen;
					details.addEventListener("toggle", () => (this.#thinkingOpen = details.open));
				}
				root.append(details);
			} else if (block.type === "text") {
				if (!block.text.trim() && !(live && last)) return;
				root.append(markdown(block.text, live && last));
			} else if (block.type === "toolCall") {
				tools ??= root.appendChild(h("div", { class: "tools" }));
				const card = new ToolCard(block.name, block.arguments ?? {});
				if (live) card.setStatus("streaming");
				else this.#cards.set(block.id, card);
				tools.append(card.element);
			}
		});
		if (!live) {
			if (message.stopReason === "error" && message.errorMessage) root.append(notice("error", t("failure.model_error"), message.errorMessage));
			const text = blocks
				.filter((block): block is Extract<Content, { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("\n\n")
				.trim();
			if (text && !blocks.some((block) => block.type === "toolCall")) {
				root.append(h("div", { class: "msg-actions" }, copyButton(() => text)));
			}
		}
		return root;
	}

	#renderLive(live: Live | undefined, empty: TranscriptState | undefined) {
		const busy = this.#busy;
		const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
		for (const [id, card] of this.#cards) {
			if (card.settled) continue;
			const slot = slots.get(id);
			if (slot) {
				card.setStatus(slot.status === "done" ? "running" : slot.status);
				card.setOutput(slot.output);
			} else card.setStatus(busy ? "pending" : "stopped");
		}

		const parts: Node[] = [];
		if (empty) parts.push(this.#empty(empty));
		const message = live?.generation?.message;
		const partial = message?.content?.some(
			(block) => (block.type === "text" && block.text) || (block.type === "thinking" && block.thinking) || block.type === "toolCall",
		);
		if (busy && message && partial) parts.push(this.#assistant(message, true));
		const running = (live?.tools ?? []).some((slot) => slot.status === "running");
		if (busy && !partial && !running) {
			parts.push(h("div", { class: "typing", role: "status" }, h("span"), h("span", null, t("thinking.live"))));
		}
		const retry = live?.generation?.retry;
		if (retry) parts.push(notice("warn", t("live.retry", retry.error, Math.max(0, Math.round((retry.at - Date.now()) / 1000)))));
		if (live?.compactions?.length) parts.push(divider(t("live.compacting"), true));
		const failure = live?.runFailure;
		if (!busy && failure) parts.push(this.#failure(failure));
		this.#live.replaceChildren(...parts);
	}

	#failure(failure: NonNullable<Live["runFailure"]>): Node {
		if (failure.reason === "aborted") return divider(t("failure.aborted"));
		const known = ["no_model", "model_error", "interrupted", "turn_limit"] as const;
		const reason = known.find((k) => k === failure.reason);
		const node = notice("error", reason ? t(`failure.${reason}`) : t("failure.other", failure.reason), failure.detail);
		node.dataset.reason = failure.reason;
		if (failure.reason === "no_model") {
			node.querySelector(".notice-body")!.append(
				h("button", { class: "btn small", type: "button", onclick: () => this.#actions.chooseModel() }, t("failure.chooseModel")),
			);
		}
		return node;
	}

	#empty(state: TranscriptState) {
		const suggestions: [IconName, string][] = [
			["eye", t("suggest.summarize")],
			["list", t("suggest.links")],
			["form", t("suggest.form")],
		];
		return h(
			"div",
			{ class: "empty" },
			h("div", { class: "empty-logo" }, logo(44)),
			h("h1", null, t("empty.title")),
			h("p", null, t("empty.subtitle")),
			state.ready
				? h(
						"div",
						{ class: "suggestions" },
						suggestions.map(([name, text]) =>
							h(
								"button",
								{ class: "suggestion", type: "button", onclick: () => this.#actions.suggest(text) },
								h("span", { class: "suggestion-icon" }, icon(name, 16)),
								h("span", null, text),
							),
						),
					)
				: h(
						"div",
						{ class: "setup" },
						h("div", { class: "setup-icon" }, icon("key", 18)),
						h("div", { class: "setup-text" }, h("strong", null, t("empty.setupTitle")), h("span", null, t("empty.setupBody"))),
						h("button", { class: "btn primary", type: "button", onclick: () => this.#actions.openSettings() }, t("empty.setupAction")),
					),
		);
	}
}
