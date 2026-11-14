import { h } from "./ui.ts";

export interface OverlayView {
	readonly element: HTMLElement;
	refresh(): void | Promise<void>;
	close(): void;
}

type Placement = {
	kind: "drawer" | "sheet" | "popover";
	anchor: HTMLElement;
	align?: "end";
	/** A popover anchored in the composer stays above the whole dock, not over its prompt and buttons. */
	boundary?: HTMLElement;
};
type ActiveOverlay = Placement & { view: OverlayView; root: HTMLElement };

const POPOVER_GAP = 8;
const POPOVER_MAX_HEIGHT = 420;

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
	#observer: ResizeObserver | undefined;

	constructor() {
		document.addEventListener("keydown", this.#keydown);
		document.addEventListener("scroll", this.#place, true);
		window.addEventListener("resize", this.#place);
	}

	get current() {
		return this.#active?.view;
	}

	open(view: OverlayView, placement: Placement) {
		this.close(false);
		const { kind, anchor } = placement;
		let root = view.element;
		if (kind === "popover") {
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
		if (kind === "popover") {
			this.#place();
			this.#observer = new ResizeObserver(this.#place);
			this.#observer.observe(root);
			this.#observer.observe(anchor);
			if (placement.boundary) this.#observer.observe(placement.boundary);
		}
		if (kind !== "popover") {
			const target = focusable(view.element)[0] ?? view.element;
			if (target === view.element) view.element.tabIndex = -1;
			target.focus({ preventScroll: true });
		}
		void this.refresh();
	}

	async refresh() {
		const active = this.#active;
		const pending = active?.view.refresh();
		// Synchronous views are fully laid out before open() returns, so their first painted frame is already anchored.
		if (this.#active === active) this.#place();
		await pending;
		if (this.#active === active) this.#place();
	}

	close(restoreFocus = true) {
		const active = this.#active;
		if (!active) return;
		this.#active = undefined;
		document.removeEventListener("pointerdown", this.#outside, true);
		this.#observer?.disconnect();
		this.#observer = undefined;
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
		document.removeEventListener("scroll", this.#place, true);
		window.removeEventListener("resize", this.#place);
	}

	/** Measures after every content refresh so menus remain inside the viewport without covering their dock. */
	#place = () => {
		const active = this.#active;
		if (!active || active.kind !== "popover" || !active.root.isConnected) return;
		const { root, anchor, boundary } = active;
		const anchorRect = anchor.getBoundingClientRect();
		const boundaryRect = boundary?.getBoundingClientRect() ?? anchorRect;
		const gutter = innerWidth <= 380 ? 8 : 12;
		const alignEnd = active.align === "end";
		// A popover hugs its anchor: the width is bounded by the room between the anchor's aligned
		// edge and the opposite gutter, so placing it never has to dodge the viewport edge.
		const maxWidth = Math.max(0, (alignEnd ? anchorRect.right : innerWidth - anchorRect.left) - gutter);
		root.style.left = "0px";
		root.style.right = "auto";
		root.style.top = "0px";
		root.style.bottom = "auto";
		root.style.maxWidth = `${maxWidth}px`;
		root.style.maxHeight = `${POPOVER_MAX_HEIGHT}px`;

		const above = Math.max(0, boundaryRect.top - POPOVER_GAP - gutter);
		const below = Math.max(0, innerHeight - boundaryRect.bottom - POPOVER_GAP - gutter);
		const desired = Math.min(root.scrollHeight, POPOVER_MAX_HEIGHT);
		const side = above >= Math.min(desired, 220) || above >= below ? "above" : "below";
		const available = side === "above" ? above : below;
		root.dataset.side = side;
		root.dataset.align = active.align === "end" ? "end" : "start";
		root.style.maxHeight = `${available}px`;

		const width = root.offsetWidth;
		const preferredLeft = alignEnd ? anchorRect.right - width : anchorRect.left;
		// The width bound above keeps the popover inside the viewport; this only guards the gutters.
		const left = Math.max(gutter, Math.min(preferredLeft, innerWidth - gutter - width));
		root.style.left = `${Math.round(left)}px`;
		const height = root.offsetHeight;
		const preferredTop = side === "above" ? boundaryRect.top - POPOVER_GAP - height : boundaryRect.bottom + POPOVER_GAP;
		const top = Math.max(gutter, Math.min(preferredTop, innerHeight - gutter - height));
		root.style.top = `${Math.round(top)}px`;
	};

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
