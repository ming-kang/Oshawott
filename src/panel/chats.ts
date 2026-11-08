import type { ChatStatus, ChatSummary, Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { LANG, t } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, logo, toast, type IconName } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>, "chats" | "deleteChat" | "renameChat">;
interface Actions {
	currentId(): number | undefined;
	select(id: number | undefined): void;
	reset(id: number): Promise<void>;
}
type ConfirmAction = "reset" | "remove";
type Confirmation = { active: boolean; timer?: ReturnType<typeof setTimeout> };
type RenameEditor = { form: HTMLFormElement; input: HTMLInputElement; save: HTMLButtonElement; cancel: HTMLButtonElement };
const context = BACKGROUND_CONTEXT;
const dayFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(LANG, { hour: "2-digit", minute: "2-digit" });
const when = (ms: number) => {
	const date = new Date(ms);
	return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
};
const statusLabel = (status: ChatStatus) => status === "idle" ? "" : t(`chat.status.${status}`);

class ChatRow {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #actions: Actions;
	readonly #title = h("span", { class: "chat-title" });
	readonly #statusText = document.createTextNode("");
	readonly #status = h("span", { class: "chat-status", hidden: true }, h("span", { class: "chat-status-dot" }), this.#statusText);
	readonly #time = h("time");
	readonly #select: HTMLButtonElement;
	readonly #rename: HTMLButtonElement;
	readonly #reset: HTMLButtonElement;
	readonly #remove: HTMLButtonElement;
	readonly #buttons: HTMLElement;
	readonly #confirmations: Record<ConfirmAction, Confirmation> = { reset: { active: false }, remove: { active: false } };
	#summary: ChatSummary;
	#editor: RenameEditor | undefined;
	#draft = "";
	#composing = false;
	#pending = false;
	#disposed = false;

	constructor(summary: ChatSummary, source: () => Source | undefined, actions: Actions) {
		this.#summary = summary;
		this.#source = source;
		this.#actions = actions;
		this.#select = h("button", {
			class: "chat-select", type: "button", "data-action": "select", onclick: () => actions.select(summary.id),
		}, this.#title, h("span", { class: "chat-meta" }, this.#status, this.#time));
		this.#rename = this.#action("rename", "compose", t("chat.rename"), () => this.#beginRename());
		this.#reset = this.#action("reset", "refresh", t("chat.resetHint"), () => void this.#confirm("reset"));
		this.#remove = this.#action("remove", "trash", t("chat.delete"), () => void this.#confirm("remove"));
		this.#buttons = h("span", { class: "chat-actions" }, this.#rename, this.#reset, this.#remove);
		this.element = h("div", { class: "chat-item", role: "listitem", "data-id": summary.id }, this.#select, this.#buttons);
	}

	get selectButton() {
		return this.#editor ? undefined : this.#select;
	}

	update(summary: ChatSummary, current: boolean) {
		this.#summary = summary;
		const title = summary.title || t("chat.untitled");
		const status = statusLabel(summary.status);
		const date = new Date(summary.updatedAt);
		const time = when(summary.updatedAt);
		if (this.#title.textContent !== title) this.#title.textContent = title;
		this.#status.hidden = !status;
		this.#status.dataset.status = summary.status;
		if (this.#statusText.data !== status) this.#statusText.data = status;
		if (this.#time.textContent !== time) this.#time.textContent = time;
		this.#time.dateTime = date.toISOString();
		this.#time.title = `${t("chat.lastActive")}: ${date.toLocaleString(LANG)}`;
		this.#select.setAttribute("aria-label", `${title}${status ? `, ${status}` : ""}, ${t("chat.lastActive")} ${time}`);
		if (current) {
			this.element.dataset.current = "true";
			this.#select.setAttribute("aria-current", "true");
		} else {
			delete this.element.dataset.current;
			this.#select.removeAttribute("aria-current");
		}
		// Only the editor's label changes: its draft, node and selection belong to this row.
		this.#editor?.input.setAttribute("aria-label", `${t("chat.rename")}: ${title}`);
		this.#refreshControls();
	}

	dispose() {
		this.#disposed = true;
		this.#revertConfirmation("reset");
		this.#revertConfirmation("remove");
	}

	#action(action: "rename" | ConfirmAction, name: IconName, label: string, onclick: () => void) {
		return h("button", {
			class: `icon-btn small chat-action ${action}`, type: "button", "data-action": action,
			title: label, "aria-label": label, onclick: (event: MouseEvent) => {
				event.stopPropagation();
				onclick();
			},
		}, icon(name, 13));
	}

	#refreshControls() {
		const title = this.#summary.title || t("chat.untitled");
		this.#rename.setAttribute("aria-label", `${t("chat.rename")}: ${title}`);
		this.#reset.setAttribute("aria-label", `${t(this.#confirmations.reset.active ? "chat.resetConfirm" : "chat.reset")}: ${title}. ${t("chat.resetHint")}`);
		this.#remove.setAttribute("aria-label", `${t(this.#confirmations.remove.active ? "chat.confirm" : "chat.delete")}: ${title}`);
		this.#rename.disabled = this.#reset.disabled = this.#remove.disabled = this.#pending;
		if (this.#editor) this.#editor.input.disabled = this.#editor.save.disabled = this.#editor.cancel.disabled = this.#pending;
	}

	#revertConfirmation(action: ConfirmAction) {
		const state = this.#confirmations[action];
		clearTimeout(state.timer);
		state.timer = undefined;
		if (!state.active) return;
		state.active = false;
		const button = action === "reset" ? this.#reset : this.#remove;
		delete button.dataset.confirm;
		button.replaceChildren(icon(action === "reset" ? "refresh" : "trash", 13));
		this.#refreshControls();
	}

	async #confirm(action: ConfirmAction) {
		if (this.#pending || this.#disposed) return;
		const state = this.#confirmations[action];
		const button = action === "reset" ? this.#reset : this.#remove;
		if (!state.active) {
			state.active = true;
			button.dataset.confirm = "";
			button.replaceChildren(t(action === "reset" ? "chat.resetConfirm" : "chat.confirm"));
			state.timer = setTimeout(() => this.#revertConfirmation(action), 3000);
			this.#refreshControls();
			return;
		}
		// The timer must not expire during the operation, and refresh must not unlock its controls.
		clearTimeout(state.timer);
		state.timer = undefined;
		const focused = this.#buttons.contains(document.activeElement);
		this.#pending = true;
		this.#refreshControls();
		// Keep focus inside the row when disabling its action, including until a removal is observed.
		if (focused) this.#select.focus({ preventScroll: true });
		try {
			const id = this.#summary.id;
			if (action === "reset") {
				await this.#actions.reset(id);
				toast(t("chat.resetDone"));
			} else {
				const source = this.#source();
				if (!source) throw new Error("The workspace is not ready.");
				await source.deleteChat({ id }, context);
				if (id === this.#actions.currentId()) this.#actions.select(undefined);
			}
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#revertConfirmation(action);
			this.#pending = false;
			this.#refreshControls();
		}
	}

	#beginRename() {
		if (this.#pending || this.#editor || this.#disposed) return;
		this.#revertConfirmation("reset");
		this.#revertConfirmation("remove");
		this.#draft = this.#summary.title;
		this.#composing = false;
		const input = h("input", {
			class: "input rename-input", type: "text", value: this.#draft, maxlength: 500,
			"aria-label": `${t("chat.rename")}: ${this.#summary.title || t("chat.untitled")}`,
			oninput: () => { this.#draft = input.value; },
			oncompositionstart: () => { this.#composing = true; },
			oncompositionend: () => { this.#composing = false; },
			onkeydown: (event: KeyboardEvent) => {
				if (event.isComposing || event.keyCode === 229 || this.#composing) {
					if (event.key === "Escape") event.stopPropagation();
					return;
				}
				if (this.#pending || event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				this.#endRename();
			},
		});
		const save = h("button", { class: "icon-btn small", type: "submit", "data-action": "save", title: t("chat.renameSave"), "aria-label": t("chat.renameSave") }, icon("check", 14));
		const cancel = h("button", {
			class: "icon-btn small", type: "button", "data-action": "cancel", title: t("chat.renameCancel"), "aria-label": t("chat.renameCancel"),
			onclick: () => { if (!this.#pending) this.#endRename(); },
		}, icon("x", 14));
		const form = h("form", { class: "rename-form", tabindex: -1, "aria-label": t("chat.rename"), onsubmit: (event: Event) => {
			event.preventDefault();
			void this.#saveRename();
		} }, input, h("span", { class: "chat-actions editing" }, save, cancel));
		this.#editor = { form, input, save, cancel };
		this.#select.hidden = this.#buttons.hidden = true;
		this.element.classList.add("editing");
		this.element.append(form);
		input.focus();
		input.select();
	}

	#endRename(focus = this.#editor?.form.contains(document.activeElement)) {
		this.#editor?.form.remove();
		this.#editor = undefined;
		this.#draft = "";
		this.#composing = false;
		this.#select.hidden = this.#buttons.hidden = false;
		this.element.classList.remove("editing");
		if (focus && !this.#disposed && this.element.isConnected) this.#rename.focus({ preventScroll: true });
	}

	async #saveRename() {
		const editor = this.#editor;
		if (!editor || this.#pending || this.#composing || this.#disposed) return;
		const hadFocus = editor.form.contains(document.activeElement);
		const shouldFocus = () => hadFocus && (editor.form.contains(document.activeElement) || document.activeElement === document.body);
		this.#pending = true;
		this.#refreshControls();
		if (hadFocus) editor.form.focus({ preventScroll: true });
		let saved = false;
		try {
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			if (this.#draft.trim() !== this.#summary.title) await source.renameChat({ id: this.#summary.id, title: this.#draft }, context);
			saved = true;
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#pending = false;
			this.#refreshControls();
			if (saved) this.#endRename(shouldFocus());
			else if (shouldFocus() && !this.#disposed) editor.input.focus({ preventScroll: true });
		}
	}
}

export class ChatDrawer implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #actions: Actions;
	readonly #list = h("div", { class: "chat-list", role: "list" });
	readonly #empty = h("div", { class: "list-empty", role: "status" }, t("chat.none"));
	readonly #rows = new Map<number, ChatRow>();
	#closed = false;

	constructor(source: () => Source | undefined, actions: Actions) {
		this.#source = source;
		this.#actions = actions;
		this.element = h(
			"aside", { class: "drawer", id: "chat-drawer", role: "dialog", "aria-modal": "true", "aria-label": t("chat.list") },
			h("div", { class: "panel-head" }, logo(22), h("span", { class: "panel-title" }, t("chat.list")),
				h("button", { class: "btn small ghost", type: "button", onclick: () => actions.select(undefined) }, icon("plus", 14), t("chat.new"))),
			this.#list,
		);
	}

	refresh() {
		if (this.#closed) return;
		const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const focusedRow = active?.closest<HTMLElement>(".chat-item");
		const focusedIndex = focusedRow?.parentElement === this.#list ? [...this.#list.children].indexOf(focusedRow) : -1;
		const items = [...(this.#source()?.chats.value ?? [])].sort((a, b) => b.updatedAt - a.updatedAt);
		const keep = new Set(items.map((item) => item.id));
		for (const [id, row] of this.#rows) {
			if (keep.has(id)) continue;
			row.dispose();
			row.element.remove();
			this.#rows.delete(id);
		}
		if (items.length) this.#empty.remove();
		else if (!this.#empty.parentElement) this.#list.append(this.#empty);

		const rows: ChatRow[] = [];
		for (const [index, summary] of items.entries()) {
			let row = this.#rows.get(summary.id);
			if (!row) {
				row = new ChatRow(summary, this.#source, this.#actions);
				this.#rows.set(summary.id, row);
			}
			row.update(summary, summary.id === this.#actions.currentId());
			const at = this.#list.children[index];
			if (at !== row.element) {
				if (row.element === focusedRow) {
					// insertBefore can blur a moved subtree. Move its intervening siblings instead, keeping focus and the caret untouched.
					while (this.#list.children[index] !== row.element) this.#list.insertBefore(this.#list.children[index]!, row.element.nextSibling);
				} else this.#list.insertBefore(row.element, at ?? null);
			}
			rows.push(row);
		}
		if (focusedIndex >= 0 && focusedRow?.parentElement !== this.#list) {
			const index = Math.min(focusedIndex, rows.length - 1);
			const neighbour = rows.slice(index).find((row) => row.selectButton) ?? rows.slice(0, index).reverse().find((row) => row.selectButton);
			const target = neighbour?.selectButton ?? this.element.querySelector<HTMLButtonElement>(".panel-head button");
			target?.focus({ preventScroll: true });
		}
	}

	close() {
		this.#closed = true;
		for (const row of this.#rows.values()) row.dispose();
	}
}
