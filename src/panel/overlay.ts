import { shallowRef, type Component } from "vue";

export type OverlayKind = "drawer" | "sheet" | "popover";
export type OverlayId = "chats" | "files" | "settings" | "provider" | "model" | "thinking" | "send-mode" | "stop";

export type OverlayPlacement = {
	id: OverlayId;
	kind: OverlayKind;
	anchor: HTMLElement;
	component: Component;
	props?: Record<string, unknown>;
	align?: "end";
	boundary?: HTMLElement;
};
export type ActiveOverlay = OverlayPlacement & { key: number };

/** One active overlay, described by data rather than imperative view classes. */
export class Overlays {
	readonly current = shallowRef<ActiveOverlay>();
	#key = 0;

	open(placement: OverlayPlacement) {
		this.close(false);
		placement.anchor.setAttribute("aria-expanded", "true");
		this.current.value = { ...placement, key: ++this.#key };
	}

	close(restoreFocus = true) {
		const active = this.current.value;
		if (!active) return;
		this.current.value = undefined;
		active.anchor.setAttribute("aria-expanded", "false");
		if (restoreFocus && active.anchor.isConnected) active.anchor.focus({ preventScroll: true });
	}

	closeIf(id: OverlayId, restoreFocus = true) {
		if (this.current.value?.id === id) this.close(restoreFocus);
	}
}
