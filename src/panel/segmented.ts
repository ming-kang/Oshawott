import { h } from "./ui.ts";

export interface SegmentedOption<T extends string> {
	value: T;
	label: string;
	id?: string;
}

export interface Segmented<T extends string> {
	readonly element: HTMLElement;
	/** Updates the checked state and roving tabindex; the caller decides what choosing means. */
	select(value: T, focus?: boolean): void;
	setDisabled(disabled: boolean): void;
}

/** A radiogroup of buttons: one tab stop on the checked option, arrows/Home/End move the choice. */
export function segmented<T extends string>(config: {
	id?: string;
	label: string;
	options: readonly SegmentedOption<T>[];
	selected: T;
	onChoose(value: T, focus: boolean): void;
}): Segmented<T> {
	const { options, onChoose } = config;
	const buttons = options.map((option, index) => h("button", {
		type: "button", role: "radio", id: option.id, "data-value": option.value,
		onclick: () => onChoose(option.value, false),
		onkeydown: (event: KeyboardEvent) => {
			const last = options.length - 1;
			const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % options.length
				: event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + last) % options.length
					: event.key === "Home" ? 0 : event.key === "End" ? last : -1;
			if (next < 0) return;
			event.preventDefault();
			onChoose(options[next]!.value, true);
		},
	}, option.label));
	const element = h("div", { class: "segmented", id: config.id, role: "radiogroup", "aria-label": config.label }, buttons);
	const select = (value: T, focus = false) => {
		for (const button of buttons) {
			const checked = button.dataset.value === value;
			button.setAttribute("aria-checked", String(checked));
			button.tabIndex = checked ? 0 : -1;
			if (checked && focus) button.focus({ preventScroll: true });
		}
	};
	select(config.selected);
	return {
		element, select,
		setDisabled(disabled) {
			for (const button of buttons) button.disabled = disabled;
		},
	};
}
