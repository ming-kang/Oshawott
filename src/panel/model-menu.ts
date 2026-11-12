import type { ModelRef, Workspace } from "../contracts/chat.ts";
import type { Reference } from "../lib/chord.ts";
import { comboboxNav } from "./combobox.ts";
import { t } from "./i18n/index.ts";
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
	readonly #nav = comboboxNav(this.#search, this.#list, ".menu-item");
	#closed = false;

	constructor(source: Source, actions: Actions) {
		this.#source = source;
		this.#actions = actions;
		this.element = h("div", { class: "popover", id: "model-menu" }, this.#search, this.#list);
		this.#search.addEventListener("input", () => this.refresh());
		this.#search.addEventListener("keydown", (event) => this.#nav.onKeydown(event));
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
		const items = this.#nav.items();
		this.#nav.activate(items.find((item) => item.getAttribute("aria-selected") === "true") ?? items[0]);
	}

	focus() {
		this.#search.focus();
	}

	close() {
		this.#closed = true;
	}
}
