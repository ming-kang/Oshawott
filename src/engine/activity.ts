import {
	type Harness, InboxDoc, type InboxState, LiveDoc, type LiveState, type Observation, type Observer, type TaskGraph,
	type TaskGraphNode, type WatchEnd,
} from "@earendil-works/pi-durable";
import type { ChatStatus } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Context } from "../lib/chord.ts";
import { WorkspaceDoc, type WorkspaceChat } from "./docs.ts";

export type ChatActivity = { id: number; status: ChatStatus };
export type ActivitySnapshot = { items: ChatActivity[] };
type Docs = { live?: LiveState; inbox?: InboxState };

/** A conversation whose observation keeps failing is shown idle instead of reattaching forever. */
const MAX_REATTACH = 3;

/** Derive presentation state on every read; no persisted busy flag can go stale after an Engine restart. */
export function chatStatus(docs: Docs | undefined, tasks: readonly TaskGraphNode[]): ChatStatus {
	const live = docs?.live;
	const running = Boolean(live?.run || live?.compactions?.length)
		|| tasks.some((task) => task.state.status === "pending" || task.state.status === "running" || task.state.status === "completing");
	if (running) return "running";
	if (live?.compactionFailure || (live?.runFailure && live.runFailure.reason !== "aborted" && live.runFailure.reason !== "reset")) return "failed";
	if (docs?.inbox?.items.some((item) => item.mode === "steer" || item.mode === "followUp")
		|| tasks.some((task) => task.state.status === "waiting" || task.state.status === "sleeping")) return "waiting";
	return "idle";
}

interface ActivityOptions {
	readonly harness: Harness;
	readonly now: () => number;
	readonly onError: (error: unknown) => void;
}

type Attached = { live?: Observation<LiveState | undefined>; inbox?: Observation<InboxState | undefined> };

/**
 * One Engine-wide status projection, shared by every Panel. It observes only each chat's small `pi.live` and `pi.inbox`
 * documents and the task graph, so conversation entries stay subject to Durable's normal document retention.
 * The Engine owns the Workspace observation and feeds the chat list in through `setChats`.
 */
export class ConversationActivity {
	readonly #options: ActivityOptions;
	readonly #observers = new Set<Observer<ActivitySnapshot>>();
	readonly #docs = new Map<number, Docs>();
	readonly #attached = new Map<number, Attached>();
	readonly #failures = new Map<number, number>();
	readonly #statuses = new Map<number, ChatStatus>();
	#graphObservation: Observation<TaskGraph> | undefined;
	#graph: TaskGraph = { tasks: {} };
	#chats: readonly WorkspaceChat[] = [];
	#value: ActivitySnapshot = { items: [] };
	#syncTail: Promise<void> = Promise.resolve();
	#activityTail: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: ActivityOptions) {
		this.#options = options;
	}

	async start(context: Context) {
		let graphRevision = 0;
		this.#graphObservation = await this.#options.harness.observeTaskGraph({
			advance: (call, ctx) => {
				if (call.kind !== "value") return;
				graphRevision++;
				this.#graph = call.value;
				this.#publish(ctx);
			},
			end: (end) => this.#report(end),
		}, context);
		if (graphRevision === 0) this.#graph = this.#graphObservation.value;
		this.#publish(context);
	}

	setChats(chats: readonly WorkspaceChat[], context: Context) {
		if (this.#closed) return;
		this.#chats = chats;
		this.#publish(context);
		this.#queueSync();
	}

	/** A Chord-followable snapshot. Attachment never owns or stops the Engine-wide observations. */
	observe(observer: Observer<ActivitySnapshot>): Promise<Observation<ActivitySnapshot>> {
		this.#observers.add(observer);
		return Promise.resolve({
			value: this.#value,
			detach: () => { this.#observers.delete(observer); },
		});
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#graphObservation?.detach();
		for (const id of [...this.#attached.keys()]) this.#detach(id);
		for (const observer of this.#observers) observer.end({ kind: "ended" });
		this.#observers.clear();
	}

	#queueSync() {
		if (this.#closed) return;
		this.#syncTail = this.#syncTail.then(() => this.#syncConversations()).catch((error) => {
			if (!this.#closed) this.#options.onError(error);
		});
	}

	#detach(id: number) {
		const attached = this.#attached.get(id);
		attached?.live?.detach();
		attached?.inbox?.detach();
		this.#attached.delete(id);
		this.#docs.delete(id);
	}

	async #syncConversations() {
		if (this.#closed) return;
		const wanted = new Set(this.#chats.map((chat) => chat.id));
		for (const id of [...this.#attached.keys()]) {
			if (wanted.has(id)) continue;
			this.#detach(id);
			this.#failures.delete(id);
			this.#statuses.delete(id);
		}
		for (const id of wanted) {
			if (this.#attached.has(id) || (this.#failures.get(id) ?? 0) >= MAX_REATTACH) continue;
			// Sync runs serially, so a Workspace update cannot attach a duplicate while this attachment is pending.
			const attached: Attached = {};
			this.#attached.set(id, attached);
			this.#docs.set(id, {});
			attached.live = await this.#observe(id, LiveDoc, "live");
			attached.inbox = await this.#observe(id, InboxDoc, "inbox");
			if (this.#closed || !this.#chats.some((chat) => chat.id === id) || this.#attached.get(id) !== attached) {
				attached.live?.detach();
				attached.inbox?.detach();
				continue;
			}
			this.#publish(BACKGROUND_CONTEXT);
		}
		this.#publish(BACKGROUND_CONTEXT);
	}

	async #observe<K extends keyof Docs>(id: number, token: typeof LiveDoc | typeof InboxDoc, key: K) {
		let revision = 0;
		const accept = (value: unknown, context: Context) => {
			const docs = this.#docs.get(id);
			if (!docs) return;
			docs[key] = value as Docs[K];
			this.#publish(context);
		};
		const observation = await this.#options.harness.observeDoc(token as typeof LiveDoc, id as never, {
			advance: (call, ctx) => {
				if (call.kind !== "value") return;
				revision++;
				accept(call.value, ctx);
			},
			end: (end) => this.#ended(id, end),
		}, BACKGROUND_CONTEXT);
		if (observation && revision === 0) accept(observation.value, BACKGROUND_CONTEXT);
		return observation as Observation<Docs[K]> | undefined;
	}

	/** An ended observation never freezes a status: drop it, show what is still known, and reattach a bounded number of times. */
	#ended(id: number, end: WatchEnd) {
		if (this.#closed) return;
		this.#report(end);
		if (!this.#attached.has(id)) return;
		this.#detach(id);
		this.#failures.set(id, (this.#failures.get(id) ?? 0) + 1);
		this.#publish(BACKGROUND_CONTEXT);
		this.#queueSync();
	}

	#publish(context: Context) {
		if (this.#closed) return;
		const items = this.#chats.map((chat) => ({
			id: chat.id,
			status: chatStatus(this.#docs.get(chat.id), Object.values(this.#graph.tasks).filter((task) => task.conversationId === chat.id)),
		}));
		for (const { id, status } of items) {
			const previous = this.#statuses.get(id);
			this.#statuses.set(id, status);
			if (previous === "running" && status !== "running") this.#recordActivity(id);
		}
		if (items.length === this.#value.items.length && items.every((item, index) => {
			const previous = this.#value.items[index];
			return previous?.id === item.id && previous.status === item.status;
		})) return;
		const value = { items };
		this.#value = value;
		for (const observer of this.#observers) {
			observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, context);
		}
	}

	/** A finished run is activity; streaming entries are not, so the Workspace is written once per run. */
	#recordActivity(id: number) {
		const at = this.#options.now();
		this.#activityTail = this.#activityTail.then(async () => {
			if (this.#closed) return;
			await this.#options.harness.commit(async (tx) => {
				const current = (await tx.doc(WorkspaceDoc)).chats.find((chat) => chat.id === id);
				if (current && (current.updatedAt ?? 0) < at) current.updatedAt = at;
			}, BACKGROUND_CONTEXT);
		}).catch((error) => {
			if (!this.#closed) this.#options.onError(error);
		});
	}

	#report(end: WatchEnd) {
		if (!this.#closed && end.kind === "failed") this.#options.onError(end.error);
	}
}
