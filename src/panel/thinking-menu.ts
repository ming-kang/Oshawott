import type { ThinkingLevel } from "../contracts/chat.ts";
import { t } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon } from "./ui.ts";

interface Actions {
	selected(): ThinkingLevel;
	pick(level: ThinkingLevel): Promise<void>;
}

export class ThinkingMenu implements OverlayView {
	readonly element: HTMLElement;
	readonly #actions: Actions;
	readonly #levels: readonly ThinkingLevel[];
	readonly #list = h("div", { class: "menu-list", role: "listbox", "aria-label": t("thinking.title") });
	#closed = false;

	constructor(levels: readonly ThinkingLevel[], actions: Actions) {
		this.#actions = actions;
		this.#levels = levels;
		this.element = h("div", { class: "popover thinking-menu", id: "thinking-menu" }, this.#list);
		this.refresh();
	}

	refresh() {
		if (this.#closed) return;
		const selected = this.#actions.selected();
		this.#list.replaceChildren(...this.#levels.map((level) => h("button", {
			class: "menu-item", type: "button", role: "option", "aria-selected": String(level === selected), "data-level": level,
			onclick: () => void this.#actions.pick(level),
		}, h("span", { class: "menu-item-name" }, t(`thinking.level.${level}`)), level === selected ? icon("check", 14) : null)));
	}

	focus() {
		(this.#list.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? this.#list.querySelector<HTMLButtonElement>("button"))?.focus();
	}

	close() {
		this.#closed = true;
	}
}
