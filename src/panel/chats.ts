// Chat list content. Current-chat ownership stays in main; this owns rows, confirmation and list refreshes.
import type { ChatSummary, Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { LANG, t } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, logo, toast } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>, "chats" | "deleteChat">;
interface Actions {
	currentId(): number | undefined;
	select(id: number | undefined): void;
}
const context = BACKGROUND_CONTEXT;
const dayFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(LANG, { hour: "2-digit", minute: "2-digit" });
const when = (ms: number) => {
	const date = new Date(ms);
	return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
};

export class ChatDrawer implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #actions: Actions;
	readonly #list = h("div", { class: "chat-list", role: "list" });
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
		const focusedId = focusedRow?.dataset.id;
		const focusedAction = active?.classList.contains("remove") ? ".remove" : ".chat-select";
		const focusedIndex = focusedRow ? [...this.#list.querySelectorAll(".chat-item")].indexOf(focusedRow) : -1;
		const items = [...(this.#source()?.chats.value ?? [])].sort((a, b) => b.createdAt - a.createdAt);
		this.#list.replaceChildren(...(items.length ? items.map((item) => this.#row(item)) : [h("div", { class: "list-empty", role: "status" }, t("chat.none"))]));
		if (focusedId !== undefined) {
			const rows = [...this.#list.querySelectorAll<HTMLElement>(".chat-item")];
			const same = rows.find((row) => row.dataset.id === focusedId);
			const target = same?.querySelector<HTMLElement>(focusedAction)
				?? rows[Math.min(Math.max(focusedIndex, 0), rows.length - 1)]?.querySelector<HTMLElement>(".chat-select")
				?? this.element.querySelector<HTMLElement>(".panel-head button");
			target?.focus({ preventScroll: true });
		}
	}

	close() {
		this.#closed = true;
	}

	#row(summary: ChatSummary) {
		const remove = h("button", { class: "icon-btn small remove", type: "button", title: t("chat.delete"), "aria-label": t("chat.delete") }, icon("trash", 14));
		remove.addEventListener("click", async (event) => {
			event.stopPropagation();
			if (remove.dataset.confirm === undefined) {
				remove.dataset.confirm = "";
				remove.replaceChildren(t("chat.confirm"));
				setTimeout(() => {
					if (!remove.isConnected || remove.disabled) return;
					delete remove.dataset.confirm;
					remove.replaceChildren(icon("trash", 14));
				}, 3000);
				return;
			}
			remove.disabled = true;
			try {
				const source = this.#source();
				if (!source) throw new Error("The workspace is not ready.");
				await source.deleteChat({ id: summary.id }, context);
				if (summary.id === this.#actions.currentId()) this.#actions.select(undefined);
			} catch (error) {
				toast(String((error as Error)?.message ?? error), "error");
			} finally {
				remove.disabled = false;
			}
		});
		const title = summary.title || t("chat.untitled");
		remove.setAttribute("aria-label", `${t("chat.delete")}: ${title}`);
		return h(
			"div",
			{ class: "chat-item", role: "listitem", "data-id": summary.id, "data-current": summary.id === this.#actions.currentId() ? "true" : null },
			h(
				"button",
				{ class: "chat-select", type: "button", "aria-current": summary.id === this.#actions.currentId() ? "true" : null, onclick: () => this.#actions.select(summary.id) },
				h("span", { class: "chat-title" }, title),
				h("time", { datetime: new Date(summary.createdAt).toISOString() }, when(summary.createdAt)),
			),
			remove,
		);
	}
}
