import { computed, shallowRef, type ComputedRef, type ShallowRef } from "vue";
import type { AgentState, InboxItem, InboxState, LiveState } from "@earendil-works/pi-durable";
import type { Watchable } from "@earendil-works/chord";
import { ConversationTranscript, type TranscriptItem as DurableTranscriptItem, type TranscriptView } from "@earendil-works/pi-durable";
import { DEFAULT_BUSY_MODE, PREFERENCE_DEFAULTS, type ApprovalView, type BusyMode, type LoginView, type ModelRef, type ProviderSummary } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import type { ChatSession, WorkspaceRef } from "./session.ts";
import { clampThinking, configuredProviders, sameModel, shownModel, supportedThinkingLevels } from "./models.ts";
import { watchMember } from "./watch-member.ts";

export type QueueItem = Extract<InboxItem, { mode: BusyMode }>;

/**
 * The panel's readable state. Chord members remain owned by ChatSession; computed selectors
 * republish only the value a component uses, so a streaming token does not redraw settings.
 */
export class PanelStore {
	readonly #session: ChatSession;
	readonly #transcript = shallowRef<TranscriptView | null>(null);
	readonly #defaultModel = shallowRef<WorkspaceRef["defaultModel"]["value"]>(null);
	readonly #defaultThinking = shallowRef<WorkspaceRef["defaultThinkingLevel"]["value"]>("off");
	readonly #preferences = {
		autoTitle: shallowRef(PREFERENCE_DEFAULTS.autoTitle),
		autoCompaction: shallowRef(PREFERENCE_DEFAULTS.autoCompaction),
		autoRetry: shallowRef(PREFERENCE_DEFAULTS.autoRetry),
		confirmActions: shallowRef(PREFERENCE_DEFAULTS.confirmActions),
	};
	#history: ConversationTranscript | undefined;
	readonly reconnecting = shallowRef(false);
	readonly sending = shallowRef(false);
	readonly forking = shallowRef(false);
	readonly conversationKey = shallowRef(0);

	readonly chats = shallowRef<ChatSession["chats"]>([]);
	readonly providers = shallowRef<readonly ProviderSummary[]>([]);
	readonly connected = computed(() => configuredProviders(this.providers.value));
	readonly logins = shallowRef<readonly LoginView[]>([]);
	readonly id: ComputedRef<number | undefined>;
	readonly status: ComputedRef<ChatSession["status"]>;
	readonly loaded: ComputedRef<boolean>;
	readonly model: ComputedRef<ModelRef | undefined>;
	readonly thinking;
	readonly busyMode = shallowRef<BusyMode>(DEFAULT_BUSY_MODE);
	readonly configuring: ComputedRef<boolean>;
	readonly ready: ComputedRef<boolean>;
	readonly title: ComputedRef<string>;
	readonly view: ComputedRef<TranscriptView | null>;
	readonly live: ComputedRef<LiveState | undefined>;
	readonly busy: ComputedRef<boolean>;
	readonly queue: ComputedRef<readonly QueueItem[]>;
	readonly approvals: ComputedRef<readonly ApprovalView[]>;
	readonly target: ComputedRef<number | null>;
	readonly preferences = computed(() => ({
		autoTitle: this.#preferences.autoTitle.value,
		autoCompaction: this.#preferences.autoCompaction.value,
		autoRetry: this.#preferences.autoRetry.value,
		confirmActions: this.#preferences.confirmActions.value,
	}));
	readonly instructions = shallowRef("");
	readonly transcript: ShallowRef<TranscriptView | null> = this.#transcript;

	constructor(session: ChatSession) {
		this.#session = session;
		this.id = computed(() => session.id);
		this.status = computed(() => session.status);
		this.loaded = computed(() => session.loaded);
		const agent = computed(() => this.transcript.value?.docs["pi.agent"] as AgentState | undefined);
		const chatModel = computed(() => agent.value?.model);
		this.model = computed((previous) => {
			const next = shownModel(this.providers.value, chatModel.value ?? this.#defaultModel.value ?? undefined);
			return sameModel(previous, next) ? previous : next;
		});
		this.thinking = computed(() => clampThinking(supportedThinkingLevels(this.providers.value, this.model.value),
			this.id.value === undefined ? this.#defaultThinking.value : agent.value?.thinkingLevel ?? "off"));
		this.configuring = computed(() => session.configuring !== undefined);
		this.ready = computed(() => this.connected.value.length > 0);
		this.title = computed(() => this.chats.value.find((chat) => chat.id === this.id.value)?.title ?? "");
		this.view = computed(() => this.transcript.value);
		this.live = computed(() => this.view.value?.docs["pi.live"] as LiveState | undefined);
		this.busy = computed(() => Boolean(this.live.value?.run));
		const inbox = computed(() => this.view.value?.docs["pi.inbox"] as InboxState | undefined);
		this.queue = computed(() => (inbox.value?.items ?? []).filter((item): item is QueueItem => item.mode === "steer" || item.mode === "followUp"));
		this.approvals = computed(() => session.approvals.value);
		this.target = computed(() => session.target.value);
	}

	async attachWorkspace(workspace: WorkspaceRef, chatsChanged: (previous: ChatSession["chats"], next: ChatSession["chats"]) => Promise<void>) {
		const bind = async <T,>(member: Watchable<T>, target: ShallowRef<T>) =>
			watchMember(await member.watch(BACKGROUND_CONTEXT), (value) => { target.value = value; });
		const chats = await workspace.chats.watch(BACKGROUND_CONTEXT);
		this.chats.value = chats.value;
		watchMember(chats, (next) => {
			const previous = this.chats.value;
			this.chats.value = next;
			if (previous !== next) return chatsChanged(previous, next);
		});
		await Promise.all([
			bind(workspace.providers, this.providers),
			bind(workspace.logins, this.logins),
			bind(workspace.defaultModel, this.#defaultModel),
			bind(workspace.defaultThinkingLevel, this.#defaultThinking),
			bind(workspace.busyMode, this.busyMode),
			bind(workspace.instructions, this.instructions),
			bind(workspace.autoTitle, this.#preferences.autoTitle),
			bind(workspace.autoCompaction, this.#preferences.autoCompaction),
			bind(workspace.autoRetry, this.#preferences.autoRetry),
			bind(workspace.confirmActions, this.#preferences.confirmActions),
		]);
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
