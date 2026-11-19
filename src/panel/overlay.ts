import { shallowRef, type Component } from "vue";

export type OverlayKind = "drawer" | "sheet" | "popover";
export type OverlayId = "chats" | "files" | "settings" | "provider" | "model" | "thinking" | "send-mode" | "stop" | "chat-actions";

export type OverlayPlacement = {
	id: OverlayId;
	kind: OverlayKind;
	anchor: HTMLElement;
	component: Component;
	props?: Record<string, unknown>;
	align?: "end";
	boundary?: HTMLElement;
	/** Stacking popovers float above an open drawer/sheet instead of replacing it. */
	stack?: boolean;
};
/** `resumed` marks a drawer/sheet restored under a closing popover: the host must not re-focus it. */
export type ActiveOverlay = OverlayPlacement & { key: number; resumed?: boolean };

export class Overlays {
	readonly current = shallowRef<ActiveOverlay>();
	/** The drawer/sheet a popover sits above; kept mounted so closing the popover lands back on it. */
	readonly under = shallowRef<ActiveOverlay>();
	#key = 0;

	open(placement: OverlayPlacement) {
		const active = this.current.value;
		if (placement.stack && active && active.kind !== "popover") {
			this.under.value = active;
			this.current.value = undefined;
		} else if (placement.stack && active?.kind === "popover") {
			// Replacing a stacked popover keeps the layer underneath it.
			this.current.value = undefined;
			active.anchor.setAttribute("aria-expanded", "false");
		} else {
			this.close(false);
			// close() may have restored a base layer; it goes away too.
			this.current.value?.anchor.setAttribute("aria-expanded", "false");
			this.current.value = undefined;
		}
		placement.anchor.setAttribute("aria-expanded", "true");
		this.current.value = { ...placement, key: ++this.#key };
	}

	close(restoreFocus = true) {
		const active = this.current.value;
		if (!active) return;
		const under = this.under.value;
		this.under.value = undefined;
		this.current.value = under ? { ...under, resumed: true } : undefined;
		active.anchor.setAttribute("aria-expanded", "false");
		if (restoreFocus && active.anchor.isConnected) active.anchor.focus({ preventScroll: true });
	}

	closeIf(id: OverlayId, restoreFocus = true) {
		if (this.current.value?.id === id) this.close(restoreFocus);
	}
}
