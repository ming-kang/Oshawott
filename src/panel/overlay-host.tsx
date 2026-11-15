import { defineComponent, h, nextTick, onBeforeUnmount, Transition, watch } from "vue";
import type { ActiveOverlay, Overlays } from "./overlay.ts";

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

function elementOf(value: unknown): HTMLElement | undefined {
	if (value instanceof HTMLElement) return value;
	const element = (value as { $el?: unknown } | null)?.$el;
	return element instanceof HTMLElement ? element : undefined;
}

/** Keeps a local popover inside the viewport and outside its composer's dock. */
export function placePopover(root: HTMLElement, active: ActiveOverlay) {
	const { anchor, boundary } = active;
	const anchorRect = anchor.getBoundingClientRect();
	const boundaryRect = boundary?.getBoundingClientRect() ?? anchorRect;
	const gutter = innerWidth <= 380 ? 8 : 12;
	const alignEnd = active.align === "end";
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
	root.dataset.align = alignEnd ? "end" : "start";
	root.style.maxHeight = `${available}px`;
	const width = root.offsetWidth;
	const preferredLeft = alignEnd ? anchorRect.right - width : anchorRect.left;
	root.style.left = `${Math.round(Math.max(gutter, Math.min(preferredLeft, innerWidth - gutter - width)))}px`;
	const height = root.offsetHeight;
	const preferredTop = side === "above" ? boundaryRect.top - POPOVER_GAP - height : boundaryRect.bottom + POPOVER_GAP;
	root.style.top = `${Math.round(Math.max(gutter, Math.min(preferredTop, innerHeight - gutter - height)))}px`;
}

export const OverlayHost = defineComponent<{ overlays: Overlays }>((props) => {
	let root: HTMLElement | undefined;
	let observer: ResizeObserver | undefined;
	let revision = 0;
	let rootKey = 0;

	const place = () => {
		const active = props.overlays.current.value;
		if (active?.kind === "popover" && root?.isConnected) placePopover(root, active);
	};
	const disconnect = () => {
		observer?.disconnect();
		observer = undefined;
	};

	const bindRoot = (key: number, value: unknown) => {
		const element = elementOf(value);
		if (element) {
			root = element;
			rootKey = key;
			place();
		} else if (rootKey === key) root = undefined;
	};

	const stop = watch(props.overlays.current, async (active, previous) => {
		const ticket = ++revision;
		disconnect();
		previous?.anchor.setAttribute("aria-expanded", "false");
		if (!active) { root = undefined; return; }
		await nextTick();
		if (ticket !== revision || props.overlays.current.value !== active) return;
		if (active.kind === "popover") {
			if (!root) return;
			place();
			observer = new ResizeObserver(place);
			observer.observe(root);
			observer.observe(active.anchor);
			if (active.boundary) observer.observe(active.boundary);
		} else if (root) {
			const target = focusable(root)[0] ?? root;
			target.focus({ preventScroll: true });
		}
	}, { flush: "post" });

	const keydown = (event: KeyboardEvent) => {
		const active = props.overlays.current.value;
		if (!active) return;
		if (event.key === "Escape") {
			event.preventDefault();
			props.overlays.close();
			return;
		}
		if (event.key !== "Tab" || !root) return;
		if (active.kind === "popover") {
			event.preventDefault();
			const direction = event.shiftKey ? -1 : 1;
			props.overlays.close();
			focusRelative(active.anchor, direction);
			return;
		}
		const items = focusable(root);
		if (!items.length) {
			event.preventDefault();
			root.focus({ preventScroll: true });
			return;
		}
		const first = items[0]!;
		const last = items.at(-1)!;
		const current = document.activeElement;
		if (event.shiftKey && (current === first || !root.contains(current))) {
			event.preventDefault();
			last.focus({ preventScroll: true });
		} else if (!event.shiftKey && (current === last || !root.contains(current))) {
			event.preventDefault();
			first.focus({ preventScroll: true });
		}
	};
	const outside = (event: PointerEvent) => {
		const active = props.overlays.current.value;
		if (active?.kind === "popover" && root && event.target instanceof Node && !root.contains(event.target) && !active.anchor.contains(event.target)) {
			props.overlays.close();
		}
	};
	document.addEventListener("keydown", keydown);
	document.addEventListener("pointerdown", outside, true);
	document.addEventListener("scroll", place, true);
	window.addEventListener("resize", place);
	onBeforeUnmount(() => {
		stop();
		disconnect();
		document.removeEventListener("keydown", keydown);
		document.removeEventListener("pointerdown", outside, true);
		document.removeEventListener("scroll", place, true);
		window.removeEventListener("resize", place);
	});

	return () => {
		const active = props.overlays.current.value;
		if (!active) return null;
		const close = () => {
			if (props.overlays.current.value?.key === active.key) props.overlays.close();
		};
		const content = h(active.component, {
			...active.props,
			"data-overlay-key": active.key,
			...(active.kind === "popover" ? {} : { role: "dialog", "aria-modal": "true" }),
			onClose: close,
			...(active.kind === "popover" ? { ref: (value: unknown) => bindRoot(active.key, value) } : {}),
		});
		if (active.kind === "popover") return content;
		return (
			<Transition
				leaveActiveClass="leaving"
				onBeforeLeave={(element) => {
					(element as HTMLElement).setAttribute("inert", "");
					(element as HTMLElement).setAttribute("aria-hidden", "true");
				}}
			>
				<div class={`overlay ${active.kind}-overlay`} key={active.key} data-overlay-key={active.key} ref={(value) => bindRoot(active.key, value)}>
					<div class="backdrop" onClick={close} />
					{content}
				</div>
			</Transition>
		);
	};
}, { props: ["overlays"] });
