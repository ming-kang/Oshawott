/** Active-descendant navigation for a combobox; each owner still filters and renders its own options. */
export interface ComboboxNav {
	/** The options currently listed, in visual order. */
	items(): HTMLButtonElement[];
	/** Highlights `item` and points `aria-activedescendant` at it; `undefined` clears the highlight. */
	activate(item: HTMLButtonElement | undefined): void;
	/** ArrowUp/ArrowDown/Home/End/Enter handling for the combobox's input. */
	onKeydown(event: KeyboardEvent): void;
}

/** Moves the active option among those `selector` matches inside `list`, keeping `search` in sync. */
export function comboboxNav(search: HTMLInputElement, list: HTMLElement, selector: string): ComboboxNav {
	const items = () => [...list.querySelectorAll<HTMLButtonElement>(selector)];
	const activate = (item: HTMLButtonElement | undefined) => {
		for (const other of items()) other.classList.toggle("active", other === item);
		if (item) search.setAttribute("aria-activedescendant", item.id);
		else search.removeAttribute("aria-activedescendant");
		item?.scrollIntoView({ block: "nearest" });
	};
	return {
		items, activate,
		onKeydown(event) {
			const options = items();
			const at = options.findIndex((item) => item.classList.contains("active"));
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				activate(options[Math.max(0, Math.min(options.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]);
			} else if (event.key === "Home" || event.key === "End") {
				event.preventDefault();
				activate(options[event.key === "Home" ? 0 : options.length - 1]);
			} else if (event.key === "Enter") {
				event.preventDefault();
				options[at]?.click();
			}
		},
	};
}
