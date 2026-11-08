import type { ConversationView, InboxItem, InboxState, LiveState } from "@earendil-works/pi-durable";
import type { BusyMode, QueueCancelResult, QueueUpdateResult } from "../contracts/chat.ts";
import { type AttachmentRef, userInput } from "../lib/attachments.ts";
import type { AttachmentInput } from "../lib/attachments.ts";
import { AttachmentPicker, pendingInput } from "./attachments.ts";
import { t } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, toast } from "./ui.ts";

type UserItem = Extract<InboxItem, { mode: BusyMode }>;
type QueueChange = { text?: string; whenBusy?: BusyMode; requestId?: string; attachments?: AttachmentInput[]; removeAttachments?: string[] };

export interface MessageQueueActions {
	update(id: number, change: QueueChange): Promise<QueueUpdateResult>;
	cancel(id: number): Promise<QueueCancelResult>;
	continue(): Promise<unknown>;
}

const inputOf = (item: UserItem) => userInput(item.entry, item.content);
const modeLabel = (mode: BusyMode) => t(mode === "steer" ? "queue.steer" : "queue.followUp");

/** A projection of `pi.inbox`; editing never becomes a second durable queue. */
export class MessageQueue {
	readonly element = h("section", { class: "queue", id: "queue", "aria-label": t("queue.title"), hidden: true });
	readonly #actions: MessageQueueActions;
	#items: UserItem[] = [];
	#signature: string | undefined;
	#failed = false;
	#pending = false;
	#editing: {
		id: number; text: string; mode: BusyMode; requestId: string; existing: AttachmentRef[]; removed: Set<string>; picker: AttachmentPicker;
	} | undefined;

	constructor(actions: MessageQueueActions) {
		this.#actions = actions;
	}

	get count() {
		return this.#items.length;
	}

	update(view: ConversationView | null) {
		const inbox = view?.docs["pi.inbox"] as InboxState | undefined;
		const items = (inbox?.items ?? []).filter((item): item is UserItem => item.mode === "steer" || item.mode === "followUp");
		const live = view?.docs["pi.live"] as LiveState | undefined;
		const failed = Boolean(!live?.run && live?.runFailure);
		const signature = JSON.stringify({ items, failed });
		if (signature === this.#signature) return;
		const lostEdit = this.#editing !== undefined && view !== null && !items.some((item) => item.id === this.#editing!.id);
		if (this.#editing && !items.some((item) => item.id === this.#editing!.id)) {
			this.#editing.picker.dispose();
			this.#editing = undefined;
		}
		this.#items = items;
		this.#failed = failed;
		this.#signature = signature;
		this.#render();
		if (lostEdit) toast(t("queue.unavailable"), "error");
	}

	#render() {
		const previous = this.element.querySelector<HTMLTextAreaElement>(".queue-editor");
		const selection = previous && document.activeElement === previous
			? { start: previous.selectionStart, end: previous.selectionEnd, direction: previous.selectionDirection } : undefined;
		this.element.hidden = this.#items.length === 0;
		if (!this.#items.length) {
			this.#editing?.picker.dispose();
			this.#editing = undefined;
			this.element.replaceChildren();
			return;
		}
		const header = h("div", { class: "queue-head" },
			h("strong", null, t("queue.count", this.#items.length)),
			this.#failed ? h("button", {
				class: "btn small queue-continue", type: "button",
				onclick: () => void this.#perform(async () => { await this.#actions.continue(); }),
			}, icon("refresh", 13), t("queue.continue")) : null,
		);
		const list = h("div", { class: "queue-list" }, this.#items.map((item) => this.#item(item)));
		this.element.replaceChildren(header, h("p", { class: "queue-hint" }, t("queue.hint")), list);
		this.#disablePending();
		if (selection && this.#editing) {
			const editor = this.element.querySelector<HTMLTextAreaElement>(`[data-submission-id="${this.#editing.id}"] .queue-editor`);
			if (editor) {
				editor.focus({ preventScroll: true });
				editor.setSelectionRange(Math.min(selection.start, editor.value.length), Math.min(selection.end, editor.value.length), selection.direction);
			}
		}
	}

	#item(item: UserItem): HTMLElement {
		const root = h("article", { class: "queue-item", "data-submission-id": item.id, "data-mode": item.mode });
		if (this.#editing?.id === item.id) {
			const editing = this.#editing;
			const editor = h("textarea", { class: "queue-editor", rows: 2, "aria-label": t("queue.edit") });
			editor.value = editing.text;
			const mode = h("select", { class: "queue-edit-mode", "aria-label": t("queue.delivery") },
				h("option", { value: "followUp" }, t("queue.followUp")),
				h("option", { value: "steer" }, t("queue.steer")),
			);
			mode.value = editing.mode;
			const save = h("button", { class: "btn primary small queue-save", type: "button" }, t("queue.save"));
			const cancel = h("button", { class: "btn small queue-edit-cancel", type: "button" }, t("queue.cancelEdit"));
			editor.addEventListener("input", () => { editing.text = editor.value; });
			editor.addEventListener("keydown", (event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					editing.picker.dispose();
					this.#editing = undefined;
					this.#render();
				} else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					save.click();
				}
			});
			mode.addEventListener("change", () => { editing.mode = mode.value as BusyMode; });
			save.addEventListener("click", () => {
				const kept = editing.existing.some((attachment) => !editing.removed.has(attachment.path));
				if (!editor.value.trim() && !kept && !editing.picker.items.length) return;
				void this.#perform(async () => {
					const result = await this.#actions.update(item.id, {
						text: editor.value.trim(), whenBusy: mode.value as BusyMode, requestId: editing.requestId,
						attachments: editing.picker.items.map(pendingInput), removeAttachments: [...editing.removed],
					});
					if (this.#editing?.id === item.id) {
						if (result === "not_found") toast(t("queue.unavailable"), "error");
						editing.picker.dispose();
						this.#editing = undefined;
					}
				});
			});
			cancel.addEventListener("click", () => { editing.picker.dispose(); this.#editing = undefined; this.#render(); });
			const existing = editing.existing.filter((attachment) => !editing.removed.has(attachment.path)).map((attachment) =>
				h("span", { class: "queue-attachment", "data-path": attachment.path }, icon(attachment.mimeType.startsWith("image/") ? "eye" : "file", 12),
					h("span", null, attachment.name), h("button", {
						class: "icon-btn small queue-attachment-remove", type: "button", title: t("attachments.remove"), "aria-label": `${t("attachments.remove")}: ${attachment.name}`,
						onclick: () => { editing.removed.add(attachment.path); this.#render(); },
					}, icon("x", 11))),
			);
			root.append(editor, h("div", { class: "queue-existing-attachments" }, existing), editing.picker.tray,
				h("div", { class: "queue-edit-bar" }, editing.picker.button, editing.picker.input, mode, cancel, save));
			return root;
		}

		const other: BusyMode = item.mode === "steer" ? "followUp" : "steer";
		root.append(
			h("button", {
				class: "queue-mode", type: "button", "data-action": "mode",
				title: t(other === "steer" ? "queue.switchSteer" : "queue.switchFollowUp"),
				onclick: () => void this.#perform(async () => {
					const result = await this.#actions.update(item.id, { whenBusy: other });
					if (result !== "updated") toast(t("queue.unavailable"), "error");
				}),
			}, modeLabel(item.mode), icon("chevron", 11)),
			h("div", { class: "queue-copy" }, h("div", { class: "queue-text" }, inputOf(item).text),
				h("div", { class: "queue-attachments" }, inputOf(item).attachments.map((attachment) =>
					h("span", { class: "queue-attachment" }, icon(attachment.mimeType.startsWith("image/") ? "eye" : "file", 11), attachment.name)))),
			h("button", {
				class: "icon-btn small queue-edit", type: "button", title: t("queue.edit"), "aria-label": t("queue.edit"),
				onclick: () => {
					this.#editing?.picker.dispose();
					this.#editing = {
						id: item.id, text: inputOf(item).text, mode: item.mode, requestId: crypto.randomUUID(),
						existing: inputOf(item).attachments, removed: new Set(), picker: new AttachmentPicker(),
					};
					this.#render();
					const editor = this.element.querySelector<HTMLTextAreaElement>(`[data-submission-id="${item.id}"] .queue-editor`);
					editor?.focus({ preventScroll: true });
					editor?.setSelectionRange(editor.value.length, editor.value.length);
				},
			}, icon("compose", 14)),
			h("button", {
				class: "icon-btn small queue-cancel", type: "button", title: t("queue.cancel"), "aria-label": t("queue.cancel"),
				onclick: () => void this.#perform(async () => {
					const result = await this.#actions.cancel(item.id);
					if (result !== "aborted") toast(t("queue.unavailable"), "error");
				}),
			}, icon("x", 14)),
		);
		return root;
	}

	async #perform(action: () => Promise<void>) {
		if (this.#pending) return;
		this.#pending = true;
		this.#disablePending();
		try {
			await action();
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#pending = false;
			this.#render();
		}
	}

	#disablePending() {
		if (!this.#pending) return;
		for (const control of this.element.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>("button, textarea, select")) {
			control.disabled = true;
		}
	}
}

/** Keyboard-accessible choice for the next message, shown only while a run is active. */
export class SendModeMenu implements OverlayView {
	readonly element = h("div", { class: "popover send-mode-menu", role: "menu", "aria-label": t("composer.delivery") });
	readonly #buttons: HTMLButtonElement[] = [];

	constructor(selected: BusyMode, pick: (mode: BusyMode) => void) {
		for (const mode of ["followUp", "steer"] as const) {
			const button = h("button", {
				class: "menu-item", type: "button", role: "menuitemradio", "aria-checked": String(selected === mode),
				"data-mode": mode, onclick: () => pick(mode),
			},
			h("span", { class: "menu-check" }, selected === mode ? icon("check", 14) : null),
			h("span", { class: "send-mode-copy" },
				h("span", { class: "menu-item-name" }, modeLabel(mode)),
				h("span", { class: "send-mode-description" }, t(mode === "steer" ? "queue.steerDescription" : "queue.followUpDescription")),
			));
			this.#buttons.push(button);
			this.element.append(button);
		}
		this.element.addEventListener("keydown", (event) => {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			event.preventDefault();
			const current = this.#buttons.indexOf(document.activeElement as HTMLButtonElement);
			const next = event.key === "Home" ? 0 : event.key === "End" ? this.#buttons.length - 1
				: (Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1) + this.#buttons.length) % this.#buttons.length;
			this.#buttons[next]?.focus();
		});
	}

	focus() {
		(this.#buttons.find((button) => button.getAttribute("aria-checked") === "true") ?? this.#buttons[0])?.focus();
	}

	refresh() {}
	close() {}
}

export class StopConfirmMenu implements OverlayView {
	readonly element: HTMLElement;
	readonly #cancel: HTMLButtonElement;

	constructor(count: number, confirm: () => void, cancel: () => void) {
		this.#cancel = h("button", { class: "btn small queue-stop-cancel", type: "button", onclick: cancel }, t("queue.keepRunning"));
		this.element = h("div", { class: "popover stop-confirm-menu", role: "dialog", "aria-label": t("composer.stop") },
			h("p", null, t("composer.stopQueue", count)),
			h("div", { class: "stop-confirm-actions" }, this.#cancel,
				h("button", { class: "btn danger small queue-stop-confirm", type: "button", onclick: confirm }, t("composer.stop"))),
		);
	}

	focus() {
		this.#cancel.focus({ preventScroll: true });
	}

	refresh() {}
	close() {}
}
