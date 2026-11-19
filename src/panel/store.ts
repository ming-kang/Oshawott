import { computed, shallowRef, type ComputedRef, type ShallowRef } from "vue";
import type { InboxItem, InboxState, LiveState } from "@earendil-works/pi-durable";
import { ConversationTranscript, type TranscriptItem as DurableTranscriptItem, type TranscriptView } from "@earendil-works/pi-durable";
import { PREFERENCE_DEFAULTS, type ApprovalView, type BusyMode, type LoginView, type ModelRef, type Preference, type ProviderSummary, type ThinkingLevel } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import type { ChatSession } from "./session.ts";

export type QueueItem = Extract<InboxItem, { mode: BusyMode }>;

/**
 * The panel's readable state. Chord members remain owned by ChatSession; computed selectors
 * republish only the value a component uses, so a streaming token does not redraw settings.
 */
export class PanelStore {
	readonly #session: ChatSession;
	readonly #revision = shallowRef(0);
	readonly #transcript = shallowRef<TranscriptView | null>(null);
	#history: ConversationTranscript | undefined;
	#inbox: InboxState | undefined;
	#queueItems: readonly QueueItem[] = [];
	#preferenceValues: Readonly<Record<Preference, boolean>> = PREFERENCE_DEFAULTS;
	readonly reconnecting = shallowRef(false);
	readonly sending = shallowRef(false);
	readonly forking = shallowRef(false);
	readonly conversationKey = shallowRef(0);

	readonly chats: ComputedRef<ChatSession["chats"]>;
	readonly providers: ComputedRef<readonly ProviderSummary[]>;
	readonly connected: ComputedRef<readonly ProviderSummary[]>;
	readonly logins: ComputedRef<readonly LoginView[]>;
	readonly id: ComputedRef<number | undefined>;
	readonly status: ComputedRef<ChatSession["status"]>;
	readonly loaded: ComputedRef<boolean>;
	readonly model: ComputedRef<ModelRef | undefined>;
	readonly thinking: ComputedRef<ThinkingLevel>;
	readonly busyMode: ComputedRef<BusyMode>;
	readonly configuring: ComputedRef<boolean>;
	readonly ready: ComputedRef<boolean>;
	readonly title: ComputedRef<string>;
	readonly view: ComputedRef<TranscriptView | null>;
	readonly live: ComputedRef<LiveState | undefined>;
	readonly busy: ComputedRef<boolean>;
	readonly queue: ComputedRef<readonly QueueItem[]>;
	readonly approvals: ComputedRef<readonly ApprovalView[]>;
	readonly target: ComputedRef<number | null>;
	readonly preferences: ComputedRef<Readonly<Record<Preference, boolean>>>;
	readonly instructions: ComputedRef<string>;
	readonly transcript: ShallowRef<TranscriptView | null> = this.#transcript;

	constructor(session: ChatSession) {
		this.#session = session;
		const select = <T,>(read: () => T): ComputedRef<T> => computed(() => {
			this.#revision.value;
			return read();
		});
		this.chats = select(() => session.chats);
		this.providers = select(() => session.providers);
		this.connected = select(() => session.connected);
		this.logins = select(() => session.workspace?.logins.value ?? []);
		this.id = select(() => session.id);
		this.status = select(() => session.status);
		this.loaded = select(() => session.loaded);
		this.model = select(() => session.model);
		this.thinking = select(() => session.thinking);
		this.busyMode = select(() => session.busyMode);
		this.configuring = select(() => session.configuring !== undefined);
		this.ready = computed(() => this.connected.value.length > 0);
		this.title = computed(() => this.chats.value.find((chat) => chat.id === this.id.value)?.title ?? "");
		this.view = computed(() => this.transcript.value);
		this.live = computed(() => this.view.value?.docs["pi.live"] as LiveState | undefined);
		this.busy = computed(() => Boolean(this.live.value?.run));
		this.queue = computed(() => {
			const inbox = this.view.value?.docs["pi.inbox"] as InboxState | undefined;
			if (inbox === this.#inbox) return this.#queueItems;
			this.#inbox = inbox;
			this.#queueItems = (inbox?.items ?? []).filter((item): item is QueueItem => item.mode === "steer" || item.mode === "followUp");
			return this.#queueItems;
		});
		this.approvals = select(() => session.chat?.approvals.value ?? []);
		this.target = select(() => session.chat?.target.value ?? null);
		this.preferences = select(() => {
			const previous = this.#preferenceValues;
			const next = Object.fromEntries(Object.keys(PREFERENCE_DEFAULTS).map((key) => [
				key, session.workspace?.[key as Preference].value ?? PREFERENCE_DEFAULTS[key as Preference],
			])) as Readonly<Record<Preference, boolean>>;
			if (Object.keys(PREFERENCE_DEFAULTS).every((key) => next[key as Preference] === previous[key as Preference])) return previous;
			this.#preferenceValues = next;
			return next;
		});
		this.instructions = select(() => session.workspace?.instructions.value ?? "");
	}

	mark() {
		this.#revision.value++;
	}

	/** A chat switch drops all client-side transcript pages along with its remote reference. */
	beginConversation(id: number | undefined) {
		this.conversationKey.value++;
		this.#history = id === undefined ? undefined : new ConversationTranscript(async (query, limit, context) => {
			const chat = this.#session.chat;
			if (!chat || this.#session.id !== id) throw new Error("The chat is not open.");
			return chat.entries({ query, limit }, context);
		});
		this.#transcript.value = null;
	}

	/** Merge one watched window synchronously; committed entries are immutable and are retained by the transcript. */
	publishView() {
		const view = this.#session.view;
		this.#transcript.value = view && this.#history ? { ...this.#history.merge(view) } : null;
		this.mark();
	}

	async loadEarlier() {
		const history = this.#history;
		if (!history) return;
		const next = await history.loadEarlier(BACKGROUND_CONTEXT);
		if (history === this.#history) this.#transcript.value = next;
	}

	async fillGap(gap: Extract<DurableTranscriptItem, { kind: "gap" }>) {
		const history = this.#history;
		if (!history) return;
		const next = await history.fillGap(gap, BACKGROUND_CONTEXT);
		if (history === this.#history) this.#transcript.value = next;
	}
}
