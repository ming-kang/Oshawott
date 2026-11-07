// One owner for drawers, sheets and the model popover. Components own their content; this owns dismissal and focus.
import { h } from "./ui.ts";

export interface OverlayView {
	readonly element: HTMLElement;
	refresh(): void | Promise<void>;
	close(): void;
}

type Placement = { kind: "drawer" | "sheet" | "popover"; anchor: HTMLElement };
type ActiveOverlay = Placement & { view: OverlayView; root: HTMLElement };

export class OverlayController {
	#active: ActiveOverlay | undefined;

	constructor() {
		document.addEventListener("keydown", this.#keydown);
	}

	get current() {
		return this.#active?.view;
	}

	open(view: OverlayView, placement: Placement) {
		this.close();
		const { kind, anchor } = placement;
		let root = view.element;
		if (kind === "popover") {
			root.style.bottom = `${innerHeight - anchor.getBoundingClientRect().top + 8}px`;
			document.addEventListener("pointerdown", this.#outside, true);
		} else {
			const backdrop = h("div", { class: "backdrop" });
			root = h("div", { class: `overlay ${kind}-overlay` }, backdrop, view.element);
			backdrop.addEventListener("click", () => {
				if (this.#active?.root === root) this.close();
			});
		}
		this.#active = { ...placement, view, root };
		anchor.setAttribute("aria-expanded", "true");
		document.body.append(root);
		void this.refresh();
	}

	async refresh() {
		await this.#active?.view.refresh();
	}

	close() {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		document.removeEventListener("pointerdown", this.#outside, true);
		active.view.close();
		active.anchor.setAttribute("aria-expanded", "false");
		if (active.kind === "popover") active.root.remove();
		else {
			active.root.classList.add("leaving");
			setTimeout(() => active.root.remove(), 180);
		}
		active.anchor.focus();
	}

	dispose() {
		this.close();
		document.removeEventListener("keydown", this.#keydown);
	}

	#keydown = (event: KeyboardEvent) => {
		if (event.key === "Escape") this.close();
	};

	#outside = (event: PointerEvent) => {
		const active = this.#active;
		if (active && event.target instanceof Node && !active.root.contains(event.target) && !active.anchor.contains(event.target)) this.close();
	};
}
