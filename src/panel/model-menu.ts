import type { ModelRef, Workspace } from "../contracts/chat.ts";
import type { Reference } from "../lib/chord.ts";
import { t } from "./i18n.ts";
import { compactTokens, configuredProviders, sameModel } from "./models.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>, "providers">;
interface Actions {
	selected(): ModelRef | undefined;
	pick(model: ModelRef): Promise<void>;
}

export class ModelMenu implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: Source;
	readonly #actions: Actions;
	readonly #search = h("input", {
		class: "menu-search", type: "search", placeholder: t("model.search"), "aria-label": t("model.search"),
		role: "combobox", "aria-autocomplete": "list", "aria-expanded": "true", "aria-controls": "model-options",
	});
	readonly #list = h("div", { class: "menu-list", id: "model-options", role: "listbox", "aria-label": t("model.choose") });
	#closed = false;

	constructor(source: Source, actions: Actions) {
		this.#source = source;
		this.#actions = actions;
		this.element = h("div", { class: "popover", id: "model-menu" }, this.#search, this.#list);
		this.#search.addEventListener("input", () => this.refresh());
		this.#search.addEventListener("keydown", (event) => {
			const items = this.#items();
			const at = items.findIndex((item) => item.classList.contains("active"));
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				this.#activate(items[Math.max(0, Math.min(items.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]);
			} else if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				this.#activate(items[event.key === "Home" ? 0 : items.length - 1]);
			} else if (event.key === "Enter") {
				event.preventDefault();
				items[at]?.click();
			}
		});
	}

	refresh() {
		if (this.#closed) return;
		const query = this.#search.value.trim().toLowerCase();
		const selected = this.#actions.selected();
		const groups = configuredProviders(this.#source.providers.value)
			.map((provider) => ({ provider, models: provider.models.filter((model) => !query || `${model.name} ${model.id}`.toLowerCase().includes(query)) }))
			.filter((group) => group.models.length);
		let option = 0;
		this.#list.replaceChildren(...(groups.length
			? groups.flatMap(({ provider, models }) => [
				h("div", { class: "menu-group" }, provider.name),
				...models.map((model) => {
					const ref = { provider: provider.id, modelId: model.id };
					const chosen = sameModel(selected, ref);
					return h("button", {
						class: "menu-item", id: `model-option-${option++}`, type: "button", role: "option", tabindex: -1,
						"aria-selected": String(chosen), "data-provider": provider.id, "data-model": model.id,
						onclick: () => void this.#actions.pick(ref),
					}, h("span", { class: "menu-item-name" }, model.name,
						h("span", { class: "menu-item-details" }, [
							model.name !== model.id ? model.id : "",
							compactTokens(model.contextWindow),
							model.vision ? t("model.vision") : "",
						].filter(Boolean).join(" · "))), chosen ? icon("check", 14) : null);
				}),
			]) : [h("div", { class: "list-empty", role: "status" }, t("model.none"))]));
		const items = this.#items();
		this.#activate(items.find((item) => item.getAttribute("aria-selected") === "true") ?? items[0]);
	}

	focus() {
		this.#search.focus();
	}

	close() {
		this.#closed = true;
	}

	#items() {
		return [...this.#list.querySelectorAll<HTMLButtonElement>(".menu-item")];
	}

	#activate(item: HTMLButtonElement | undefined) {
		for (const other of this.#items()) other.classList.toggle("active", other === item);
		if (item) this.#search.setAttribute("aria-activedescendant", item.id);
		else this.#search.removeAttribute("aria-activedescendant");
		item?.scrollIntoView({ block: "nearest" });
	}
}
