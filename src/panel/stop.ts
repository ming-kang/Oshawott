import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import type { Composer } from "./composer.ts";
import type { OverlayController } from "./overlays.ts";
import { type MessageQueue, StopConfirmMenu } from "./queue.ts";
import type { ChatRef } from "./session.ts";
import { toastError } from "./ui.ts";

interface StopHost {
	overlays: OverlayController;
	queue: MessageQueue;
	composer: Composer;
	chat(): ChatRef | undefined;
	busy(): boolean;
}

/** Stops the visible chat's run, asking first when messages are queued behind it. */
export class StopControl {
	readonly #host: StopHost;
	#confirm: { menu: StopConfirmMenu; chat: ChatRef; anchor: HTMLElement; count: number } | undefined;

	constructor(host: StopHost) {
		this.#host = host;
	}

	request(anchor: HTMLElement) {
		const { overlays, queue } = this.#host;
		const target = this.#host.chat();
		if (!target) return;
		const abort = () => void target.abort(BACKGROUND_CONTEXT).catch(toastError);
		if (!queue.count) return abort();
		const menu = new StopConfirmMenu(queue.count, () => {
			overlays.close();
			abort();
		}, () => overlays.close());
		this.#confirm = { menu, chat: target, anchor, count: queue.count };
		overlays.open(menu, { kind: "popover", anchor });
		menu.focus();
	}

	/** Closes the confirmation once it is stale; call after the composer renders. */
	sync() {
		const { overlays, queue, composer } = this.#host;
		const confirm = this.#confirm;
		if (!(overlays.current instanceof StopConfirmMenu) || confirm?.menu !== overlays.current) return;
		// The confirmation names this run's queue size; it is stale once the run ends, the chat or count changes, or its Stop control goes away.
		const busy = this.#host.busy();
		const anchorShown = confirm.anchor === composer.send ? busy && !composer.hasContent : !composer.stop.hidden;
		if (!busy || confirm.chat !== this.#host.chat() || !anchorShown || queue.count !== confirm.count) {
			// Its anchor may now be hidden; return focus to the prompt only if the confirmation held it.
			const focused = confirm.menu.element.contains(document.activeElement);
			overlays.close(false);
			if (focused) composer.focus({ preventScroll: true });
		}
	}
}
