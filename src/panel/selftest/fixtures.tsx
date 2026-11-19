import { computed, createApp, h, nextTick, shallowRef, type App } from "vue";
import { ConversationTranscript, type ConversationView, type InboxState, type LiveState, type TranscriptView } from "@earendil-works/pi-durable";
import type { PanelController } from "../controller.ts";
import { MessageQueue } from "../queue.tsx";
import { Transcript } from "../transcript.tsx";
import { h as dom } from "../ui.ts";

export type TranscriptFixtureActions = {
	suggest(text: string): void; openSettings(): void; chooseModel(): void; allowed(site: string): void;
	retry(): Promise<unknown>; readFile(path: string): Promise<Uint8Array>;
};
export type TranscriptFixtureState = { kind: "loading" } | { kind: "empty"; ready: boolean } | { kind: "conversation"; view: ConversationView; ready: boolean };

/** Mounts the real Vue transcript against local state; no production adapter or second renderer. */
export class TranscriptFixture {
	readonly element = dom("div");
	readonly controller: PanelController;
	readonly #transcript = shallowRef<TranscriptView | null>(null);
	readonly #status = shallowRef<"new" | "loading" | "open">("open");
	readonly #loaded = shallowRef(true);
	readonly #ready = shallowRef(true);
	readonly #live = computed(() => this.#transcript.value?.docs["pi.live"] as LiveState | undefined);
	readonly #busy = computed(() => Boolean(this.#live.value?.run));
	readonly #app: App;
	#history = new ConversationTranscript(async () => { throw new Error("No history in this fixture."); });

	constructor(actions: TranscriptFixtureActions) {
		const store = {
			transcript: this.#transcript, status: this.#status, loaded: this.#loaded, ready: this.#ready,
			view: computed(() => this.#transcript.value), live: this.#live, busy: this.#busy, forking: shallowRef(false),
			loadEarlier: async () => undefined, fillGap: async () => undefined,
		};
		this.controller = {
			store,
			scroller: shallowRef(),
			session: { opened: { readFile: ({ path }: { path: string }) => actions.readFile(path), continueQueued: actions.retry } },
			openSettings: actions.openSettings, openModelMenu: actions.chooseModel,
			send: (text?: string) => text === undefined ? Promise.resolve() : actions.suggest(text),
			failureMessage: actions.allowed,
		} as unknown as PanelController;
		this.#app = createApp({ render: () => h(Transcript, { controller: this.controller }) });
		this.#app.mount(this.element);
	}

	get busy() { return this.#busy.value; }

	async update(state: TranscriptFixtureState) {
		if (state.kind === "conversation") {
			this.#status.value = "open";
			this.#ready.value = state.ready;
			this.#transcript.value = { ...this.#history.merge(state.view) };
		} else {
			this.#transcript.value = null;
			this.#status.value = state.kind === "empty" ? "new" : "loading";
			if (state.kind === "empty") this.#ready.value = state.ready;
		}
		await nextTick();
		await nextTick();
	}

	dispose() { this.#app.unmount(); }
}

export class QueueFixture {
	readonly element = dom("div");
	readonly #view = shallowRef<ConversationView | null>(null);
	readonly #queue = computed(() => {
		const inbox = this.#view.value?.docs["pi.inbox"] as InboxState | undefined;
		return (inbox?.items ?? []).filter((item) => item.mode === "steer" || item.mode === "followUp");
	});
	readonly #live = computed(() => this.#view.value?.docs["pi.live"] as LiveState | undefined);
	readonly #app: App;

	constructor(actions: {
		update(id: number, change: Record<string, unknown>): Promise<unknown>; cancel(id: number): Promise<unknown>; continue(): Promise<unknown>;
	}) {
		const controller = {
			store: { queue: this.#queue, live: this.#live, view: this.#view },
			session: { opened: {
				updateQueued: ({ id, ...change }: { id: number }) => actions.update(id, change),
				cancelQueued: ({ id }: { id: number }) => actions.cancel(id), continueQueued: actions.continue,
			} },
		} as unknown as PanelController;
		this.#app = createApp({ render: () => h(MessageQueue, { controller }) });
		this.#app.mount(this.element);
	}

	get count() { return this.#queue.value.length; }
	get hidden(): boolean { return this.element.querySelector<HTMLElement>("#queue")?.hidden === true; }
	async update(view: ConversationView | null) { this.#view.value = view; await nextTick(); }
	dispose() { this.#app.unmount(); }
}
