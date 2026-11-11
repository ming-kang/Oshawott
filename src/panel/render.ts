// Committed entries never change and are built once by ID; a tool result fills its call's card.
// Only `pi.live` (streaming answer, running tools, retry, last failure) is rebuilt on every change.
import type { AssistantMessage, ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import type { ConversationView, EntryRecord, LiveState, RunFailure, RunFailureReason } from "@earendil-works/pi-durable";
import { isImageAttachment, type AttachmentRef, USER_ENTRY, userInput } from "../lib/attachments.ts";
import { fromBase64 } from "../lib/base64.ts";
import { formatBytes } from "../lib/bytes.ts";
import { t } from "./i18n.ts";
import { markdown } from "./markdown-dom.ts";
import { ToolCard } from "./tool-card.ts";
import { copyText, download, errorMessage, h, type IconName, icon, mascot, toastError } from "./ui.ts";

const FAILURE_LABELS = {
	no_model: "failure.no_model", model_error: "failure.model_error", interrupted: "failure.interrupted", turn_limit: "failure.turn_limit",
	aborted: "failure.aborted", reset: null, faulted: null, orphaned: null, restart_limit: null, nothing_to_answer: null,
} as const satisfies Record<RunFailureReason, string | null>;

export interface TranscriptActions {
	suggest(text: string): void;
	openSettings(): void;
	chooseModel(): void;
	/** Tries a failed run again from where it stopped. */
	retry(): Promise<unknown>;
	/** The user allowed the site a tool call was refused on. */
	allowed(site: string): void;
	readFile(path: string): Promise<Uint8Array>;
}

export type TranscriptState =
	| { kind: "loading" }
	| { kind: "empty"; ready: boolean }
	| { kind: "conversation"; view: ConversationView; ready: boolean };

const textOf = (content: UserMessage["content"]) =>
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
	#objectUrls = new Map<string, Set<string>>();
	#revision = 0;

	constructor(actions: TranscriptActions) {
		this.#actions = actions;
		this.#live = h("div", { class: "live" });
		this.element = h("div", { class: "thread" }, this.#live);
	}

	get busy() {
		return this.#busy;
	}

	clear() {
		this.#revision++;
		for (const urls of this.#objectUrls.values()) for (const url of urls) URL.revokeObjectURL(url);
		this.#objectUrls.clear();
		for (const node of this.#nodes.values()) node.remove();
		this.#nodes.clear();
		this.#cards.clear();
		this.#live.replaceChildren();
		this.#thinkingOpen = false;
		this.#busy = false;
	}

	update(state: TranscriptState) {
		if (state.kind === "loading") {
			this.#live.replaceChildren(h("div", { class: "connecting" }, h("span", { class: "spinner" }), t("connecting")));
			return;
		}
		if (state.kind === "empty") {
			this.clear();
			this.#renderLive(undefined, state);
			return;
		}
		const { view } = state;
		const entries = view.entries;
		const keep = new Set<string>();
		let index = 0;
		let visible = 0;
		for (const entry of entries) {
			const key = String(entry.id);
			keep.add(key);
			if (entry.kind === "pi.user" || entry.kind === USER_ENTRY || entry.kind === "pi.assistant") visible++;
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
			for (const url of this.#objectUrls.get(key) ?? []) URL.revokeObjectURL(url);
			this.#objectUrls.delete(key);
		}
		for (const [id, card] of this.#cards) if (!card.element.isConnected) this.#cards.delete(id);

		const live = view.docs["pi.live"] as LiveState | undefined;
		this.#busy = Boolean(live?.run);
		this.#renderLive(live, visible === 0 && !this.#busy ? state : undefined);
	}

	#entry(entry: EntryRecord): HTMLElement {
		const message = entry.model?.[0];
		switch (entry.kind) {
			case "pi.user":
			case USER_ENTRY:
				return message?.role === "user" ? this.#user(entry, message, String(entry.id)) : h("div", { hidden: true });
			case "pi.assistant":
				return message?.role === "assistant" ? this.#assistant(message, false) : h("div", { hidden: true });
			case "pi.tool-result": {
				if (message?.role !== "toolResult") return h("div", { hidden: true });
				const text = textOf(message.content);
				const diagnostics = ToolResultEntry.is(entry) ? entry.data?.diagnostics : undefined;
				const card = this.#cards.get(message.toolCallId);
				if (card) {
					card.setResult(text, message.isError, message.details, diagnostics);
					return h("div", { hidden: true });
				}
				// The call itself is before the window: a card of its own.
				const orphan = new ToolCard(message.toolName, {}, this.#actions.allowed);
				orphan.setResult(text, message.isError, message.details, diagnostics);
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

	#user(entry: EntryRecord, message: UserMessage, key: string): HTMLElement {
		const { text, attachments: refs } = userInput(entry, message.content);
		const bubble = h("div", { class: "bubble" }, text ? h("div", { class: "user-text" }, text) : null);
		const images = typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "image");
		const referencedImages = refs.filter(isImageAttachment).length;
		let imageIndex = 0;
		if (refs.length) bubble.append(h("div", { class: "user-attachments" }, refs.map((ref) =>
			this.#attachment(ref, key, isImageAttachment(ref) ? images[imageIndex++] : undefined))));
		// Image blocks beyond the entry's image attachments (an image-only `pi.user` input) show on their own.
		for (const image of images.slice(referencedImages)) {
			bubble.append(h("img", { class: "user-image", src: `data:${image.mimeType};base64,${image.data}`, alt: t("attachments.title") }));
		}
		return h("div", { class: "msg user" }, bubble);
	}

	#attachment(ref: AttachmentRef, key: string, native?: ImageContent): HTMLElement {
		const revision = this.#revision;
		let bytes: Promise<Uint8Array> | undefined;
		const load = () => {
			bytes ??= native ? Promise.resolve(fromBase64(native.data)) : this.#actions.readFile(ref.path);
			return bytes.catch((error) => { bytes = undefined; throw error; });
		};
		const card = h("button", {
			class: `user-attachment${isImageAttachment(ref) ? " image" : ""}`, type: "button", "data-path": ref.path,
			title: `${t("files.download")}: ${ref.name}`,
		},
			native ? h("img", { class: "user-attachment-preview", src: `data:${native.mimeType};base64,${native.data}`, alt: "" })
				: isImageAttachment(ref) ? h("span", { class: "attachment-loading" }, h("span", { class: "spinner" })) : icon("file", 18),
			h("span", { class: "user-attachment-copy" }, h("span", { class: "attachment-name" }, ref.name),
				h("span", { class: "attachment-size" }, `${formatBytes(ref.size)}${ref.lines !== undefined ? ` · ${ref.lines} lines` : ""}`)),
			icon("download", 14),
		);
		card.addEventListener("click", async () => {
			card.setAttribute("disabled", "");
			try {
				download(await load(), ref.name, ref.mimeType);
			} catch (error) {
				card.classList.add("failed");
				card.append(h("span", { class: "sr-only" }, errorMessage(error)));
			} finally {
				card.removeAttribute("disabled");
			}
		});
		if (isImageAttachment(ref) && !native) {
			void load().then((data) => {
				if (revision !== this.#revision || !this.#nodes.has(key)) return;
				const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: ref.mimeType }));
				const urls = this.#objectUrls.get(key) ?? new Set<string>();
				urls.add(url);
				this.#objectUrls.set(key, urls);
				card.querySelector(".attachment-loading")?.replaceWith(h("img", { class: "user-attachment-preview", src: url, alt: "" }));
			}).catch(() => {
				card.classList.add("failed");
				card.querySelector(".attachment-loading")?.replaceWith(icon("alert", 17));
			});
		}
		return card;
	}

	#assistant(message: AssistantMessage, live: boolean): HTMLElement {
		const root = h("div", { class: "msg assistant", "data-live": live || null });
		const blocks = message.content;
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
				);
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
				const card = new ToolCard(block.name, block.arguments, this.#actions.allowed);
				if (live) card.setStatus("streaming");
				else this.#cards.set(block.id, card);
				tools.append(card.element);
			}
		});
		if (!live) {
			if (message.stopReason === "error" && message.errorMessage) root.append(notice("error", t("failure.model_error"), message.errorMessage));
			const text = blocks
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n\n")
				.trim();
			if (text && !blocks.some((block) => block.type === "toolCall")) {
				root.append(h("div", { class: "msg-actions" }, copyButton(() => text)));
			}
		}
		return root;
	}

	#renderLive(live: LiveState | undefined, empty: { ready: boolean } | undefined) {
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

	#failure(failure: RunFailure): Node {
		if (failure.reason === "aborted") return divider(t("failure.aborted"));
		const label = FAILURE_LABELS[failure.reason];
		const node = notice("error", label ? t(label) : t("failure.other", failure.reason), failure.detail);
		node.dataset.reason = failure.reason;
		const body = node.querySelector(".notice-body")!;
		if (failure.reason === "no_model") {
			body.append(h("button", { class: "btn small", type: "button", onclick: () => this.#actions.chooseModel() }, t("failure.chooseModel")));
		} else {
			const retry = h("button", { class: "btn small", id: "retry", type: "button" }, icon("refresh", 13), t("failure.retry"));
			retry.addEventListener("click", () => {
				retry.disabled = true;
				void this.#actions.retry().catch((error) => {
					retry.disabled = false;
					toastError(error);
				});
			});
			body.append(retry);
		}
		return node;
	}

	#empty(state: { ready: boolean }) {
		const suggestions: [IconName, string][] = [
			["eye", t("suggest.summarize")],
			["list", t("suggest.links")],
			["form", t("suggest.form")],
		];
		return h(
			"div",
			{ class: "empty" },
			h("div", { class: "empty-logo" }, mascot()),
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
