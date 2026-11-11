import type { AttachmentInput } from "../lib/attachments.ts";
import { DraftStore, type ComposerDraft } from "./drafts.ts";

/** What the session needs from the composer: its content, a change counter, and a way to write a draft back. */
export interface DraftSource {
	/** Bumped by every edit and import, so a slow read can tell whether the composer changed meanwhile. */
	readonly revision: number;
	draft(): ComposerDraft;
	restore(draft: ComposerDraft | undefined): void;
	/** Empties the text and attachments and invalidates in-flight imports. */
	reset(): void;
}

export interface SwitchOptions {
	/** Keep the composer's content: the draft follows it to the new chat. */
	preserveComposer?: boolean;
	/** The previous chat is gone: delete its draft instead of saving it. */
	discardPrevious?: boolean;
}

/** Persists the composer draft per chat and keeps asynchronous reads and writes from overwriting newer input. */
export class DraftSession {
	readonly #source: DraftSource;
	readonly #chatId: () => number | undefined;
	readonly #store = DraftStore.open();
	#ready = false;
	#load = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#writes: Promise<void> = Promise.resolve();

	constructor(source: DraftSource, chatId: () => number | undefined) {
		this.#source = source;
		this.#chatId = chatId;
		addEventListener("pagehide", () => { if (this.#ready) void this.flush(); });
	}

	/** True once the visible chat's draft has been read, so edits may be saved. */
	get ready() {
		return this.#ready;
	}

	/** Changes on every chat switch; compare against an earlier value to detect that the visible chat changed. */
	get generation() {
		return this.#load;
	}

	async opened() {
		await this.#store;
	}

	schedule() {
		if (!this.#ready) return;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		const id = this.#chatId();
		const snapshot = this.#source.draft();
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.#write(id, snapshot);
		}, 180);
	}

	flush(id: number | undefined = this.#chatId()) {
		this.#cancelTimer();
		return this.#write(id, this.#source.draft());
	}

	async forget(id: number | undefined) {
		await (await this.#store).remove(id).catch(() => undefined);
	}

	/** Leaves the current chat's draft and enters `id`'s. `commit` swaps the visible chat synchronously, between the two. */
	async switchTo(id: number | undefined, options: SwitchOptions, commit: () => void) {
		const previous = this.#chatId();
		const previousDraft = this.#source.draft();
		const previousReady = this.#ready;
		this.#cancelTimer();
		const load = ++this.#load;
		this.#ready = false;
		if (!options.preserveComposer) {
			// Invalidate imports and remove A's visible bytes synchronously, before B's asynchronous draft read starts.
			this.#source.reset();
		}
		if (options.discardPrevious) {
			const writes = this.#writes;
			void (async () => {
				await writes;
				await this.forget(previous);
			})();
		} else if ((previousReady || previousDraft.text || previousDraft.attachments.length) && !options.preserveComposer) {
			void this.#write(previous, previousDraft);
		}
		commit();
		if (options.preserveComposer) {
			await this.#write(id, this.#source.draft());
			if (previous !== id) await this.forget(previous);
			if (load === this.#load) this.#ready = true;
		} else await this.#restore(id, load);
	}

	/** A first message created chat `id` while the user moved elsewhere: the "new chat" draft is theirs to keep, so copy it over. */
	async adopt(id: number, fallback: ComposerDraft) {
		await this.#writes;
		const store = await this.#store;
		const pending = await store.load(undefined).catch(() => undefined);
		await this.#write(id, pending ?? fallback);
		if (this.#chatId() !== undefined) await store.remove(undefined).catch(() => undefined);
	}

	/** Removes what was just sent from chat `id`'s draft; `visible` means the composer still shows that chat's draft. */
	async submitted(id: number, raw: string, items: readonly AttachmentInput[], visible: boolean) {
		if (visible) return this.flush(id);
		await this.#writes;
		const draft = await (await this.#store).load(id).catch(() => undefined);
		if (!draft) return;
		const ids = new Set(items.map((item) => item.id));
		await this.#write(id, {
			text: draft.text === raw ? "" : draft.text,
			attachments: draft.attachments.filter((item) => !ids.has(item.id)), updatedAt: Date.now(),
		});
	}

	#cancelTimer() {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
	}

	#write(id: number | undefined, snapshot: ComposerDraft) {
		this.#writes = this.#writes.then(async () => (await this.#store).save(id, snapshot)).catch((error) => console.debug("[oshawott draft]", error));
		return this.#writes;
	}

	async #restore(id: number | undefined, load: number) {
		const revision = this.#source.revision;
		const draft = await (await this.#store).load(id).catch(() => undefined);
		if (load !== this.#load || this.#chatId() !== id) return;
		if (revision !== this.#source.revision) {
			// A slow database read must never overwrite text or imports that arrived meanwhile.
			this.#ready = true;
			this.schedule();
			return;
		}
		this.#source.restore(draft);
		this.#ready = true;
	}
}
