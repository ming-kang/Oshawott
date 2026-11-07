import { h } from "./ui.ts";

export interface OverlayView {
	readonly element: HTMLElement;
	refresh(): void | Promise<void>;
	close(): void;
}

type Placement = { kind: "drawer" | "sheet" | "popover"; anchor: HTMLElement };
type ActiveOverlay = Placement & { view: OverlayView; root: HTMLElement };

const FOCUSABLE = "a[href], button, input, select, textarea, summary, [contenteditable='true'], [tabindex]";
function focusable(root: ParentNode): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) =>
		!element.matches(":disabled") && element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest("[inert]"),
	);
}

function focusRelative(anchor: HTMLElement, direction: 1 | -1) {
	const items = focusable(document);
	const index = items.indexOf(anchor);
	const target = items[index + direction] ?? items[direction > 0 ? 0 : items.length - 1];
	target?.focus({ preventScroll: true });
}

export class OverlayController {
	#active: ActiveOverlay | undefined;

	constructor() {
		document.addEventListener("keydown", this.#keydown);
	}

	get current() {
		return this.#active?.view;
	}

	open(view: OverlayView, placement: Placement) {
		this.close(false);
		const { kind, anchor } = placement;
		let root = view.element;
		if (kind === "popover") {
			root.style.bottom = `${innerHeight - anchor.getBoundingClientRect().top + 8}px`;
			document.addEventListener("pointerdown", this.#outside, true);
		} else {
			view.element.setAttribute("role", view.element.getAttribute("role") ?? "dialog");
			view.element.setAttribute("aria-modal", "true");
			const backdrop = h("div", { class: "backdrop" });
			root = h("div", { class: `overlay ${kind}-overlay` }, backdrop, view.element);
			backdrop.addEventListener("click", () => {
				if (this.#active?.root === root) this.close();
			});
		}
		this.#active = { ...placement, view, root };
		anchor.setAttribute("aria-expanded", "true");
		document.body.append(root);
		if (kind !== "popover") {
			const target = focusable(view.element)[0] ?? view.element;
			if (target === view.element) view.element.tabIndex = -1;
			target.focus({ preventScroll: true });
		}
		void this.refresh();
	}

	async refresh() {
		await this.#active?.view.refresh();
	}

	close(restoreFocus = true) {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		document.removeEventListener("pointerdown", this.#outside, true);
		active.view.close();
		active.anchor.setAttribute("aria-expanded", "false");
		if (active.kind === "popover") active.root.remove();
		else {
			active.root.classList.add("leaving");
			active.root.setAttribute("inert", "");
			active.root.setAttribute("aria-hidden", "true");
			setTimeout(() => active.root.remove(), 180);
		}
		if (restoreFocus && active.anchor.isConnected) active.anchor.focus({ preventScroll: true });
	}

	dispose() {
		this.close();
		document.removeEventListener("keydown", this.#keydown);
	}

	#keydown = (event: KeyboardEvent) => {
		const active = this.#active;
		if (!active) return;
		if (event.key === "Escape") {
			event.preventDefault();
			this.close();
			return;
		}
		if (event.key !== "Tab") return;
		if (active.kind === "popover") {
			event.preventDefault();
			const direction = event.shiftKey ? -1 : 1;
			const anchor = active.anchor;
			this.close();
			focusRelative(anchor, direction);
			return;
		}
		const items = focusable(active.view.element);
		if (!items.length) {
			event.preventDefault();
			active.view.element.focus({ preventScroll: true });
			return;
		}
		const first = items[0]!;
		const last = items.at(-1)!;
		const current = document.activeElement;
		if (event.shiftKey && (current === first || !active.view.element.contains(current))) {
			event.preventDefault();
			last.focus({ preventScroll: true });
		} else if (!event.shiftKey && (current === last || !active.view.element.contains(current))) {
			event.preventDefault();
			first.focus({ preventScroll: true });
		}
	};

	#outside = (event: PointerEvent) => {
		const active = this.#active;
		if (active && event.target instanceof Node && !active.root.contains(event.target) && !active.anchor.contains(event.target)) this.close();
	};
}
