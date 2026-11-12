import {
	type ConversationDocToken, type ConversationId, type Harness, InboxDoc, type InboxState, type JsonObject, LiveDoc,
	type LiveState, type Observation, type TaskGraph, type TaskGraphNode, type WatchEnd,
} from "@earendil-works/pi-durable";
import type { ChatStatus } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Context } from "../lib/chord.ts";
import { WorkspaceDoc, type WorkspaceChat } from "./docs.ts";
import { Published } from "./published.ts";

export type ChatActivity = { id: number; status: ChatStatus };
export type ActivitySnapshot = { items: ChatActivity[] };
type Docs = { live?: LiveState; inbox?: InboxState };
/** The observations one chat is attached with. */
type Attached = { live?: Observation<Readonly<LiveState>>; inbox?: Observation<Readonly<InboxState>> };

/** A conversation whose observation keeps failing is shown idle instead of reattaching forever. */
const MAX_REATTACH = 3;

/** A Workspace chat id is its conversation id: the Workspace creates both from one counter. */
const asConversation = (id: number): ConversationId => id as ConversationId;

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

/**
 * One Engine-wide status projection, shared by every Panel. It observes only each chat's small `pi.live` and `pi.inbox`
 * documents and the task graph, so conversation entries stay subject to Durable's normal document retention.
 * The Engine owns the Workspace observation and feeds the chat list in through `setChats`.
 */
export class ConversationActivity {
	readonly #options: ActivityOptions;
	readonly #published = new Published<ActivitySnapshot>({ items: [] });
	readonly #docs = new Map<number, Docs>();
	readonly #attached = new Map<number, Attached>();
	readonly #failures = new Map<number, number>();
	readonly #statuses = new Map<number, ChatStatus>();
	#graphObservation: Observation<TaskGraph> | undefined;
	#graph: TaskGraph = { tasks: {} };
	#chats: readonly WorkspaceChat[] = [];
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

	/** A Chord-followable snapshot. Following it never owns or stops the Engine-wide observations. */
	readonly observe = this.#published.observe.bind(this.#published);

	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#graphObservation?.detach();
		for (const id of [...this.#attached.keys()]) this.#detach(id);
		this.#published.close();
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

	/** Release an attempt's own observations, and forget the chat only while that attempt still owns its records. */
	#release(id: number, attached: Attached) {
		attached.live?.detach();
		attached.inbox?.detach();
		if (this.#attached.get(id) !== attached) return;
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
			try {
				await this.#attach(id);
			} catch (error) {
				// The attempt released everything it created, so this chat is retried within the bound, as an ended
				// observation is; one chat's failure leaves the others to attach.
				if (!this.#closed) this.#options.onError(error);
				this.#retry(id);
			}
		}
		this.#publish(BACKGROUND_CONTEXT);
	}

	/**
	 * Attach both of a chat's documents, or neither. The typed record is in `#attached` and `#docs` for the whole
	 * attempt, so a serial Sync cannot attach the same chat twice; every exit releases it, so a failed or superseded
	 * attempt leaves no half-attached chat behind for a later bounded retry.
	 */
	async #attach(id: number) {
		const attached: Attached = {};
		const docs: Docs = {};
		this.#attached.set(id, attached);
		this.#docs.set(id, docs);
		// The two initial observations are independent, so their waits run together. `allSettled` keeps the one that
		// succeeded when the other failed, so the attempt can release it instead of leaking it.
		const pending = [
			this.#observe(id, LiveDoc, (value, ctx) => { docs.live = value; this.#publish(ctx); }),
			this.#observe(id, InboxDoc, (value, ctx) => { docs.inbox = value; this.#publish(ctx); }),
		] as const;
		const [live, inbox] = await Promise.allSettled(pending);
		attached.live = live.status === "fulfilled" ? live.value : undefined;
		attached.inbox = inbox.status === "fulfilled" ? inbox.value : undefined;
		const failed = [live, inbox].filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failed.length > 0) {
			this.#release(id, attached);
			// A value delivered before the other attach failed may have published a status nothing backs any more.
			this.#publish(BACKGROUND_CONTEXT);
			if (failed.length === 1) throw failed[0]!.reason;
			throw new AggregateError(failed.map((result) => result.reason), `Could not observe chat ${id}`);
		}
		// The chat left the Workspace, the activity closed, or an ended observation released this attempt meanwhile.
		if (this.#closed || !this.#chats.some((chat) => chat.id === id) || this.#attached.get(id) !== attached) {
			this.#release(id, attached);
			return;
		}
		// The retry budget limits consecutive failures, not independent failures over the Engine's whole lifetime.
		this.#failures.delete(id);
		this.#publish(BACKGROUND_CONTEXT);
	}

	/**
	 * Attach one of a chat's documents, handing each value to `accept` as it arrives: the first `advance`, or the
	 * observation's value when none did. `undefined` when the conversation has no such document yet.
	 */
	async #observe<T extends JsonObject>(
		id: number, token: ConversationDocToken<T>, accept: (value: Readonly<T>, context: Context) => void,
	): Promise<Observation<Readonly<T>> | undefined> {
		let revision = 0;
		const observation = await this.#options.harness.observeDoc(token, asConversation(id), {
			advance: (call, ctx) => {
				if (call.kind !== "value") return;
				revision++;
				accept(call.value, ctx);
			},
			end: (end) => this.#ended(id, end),
		}, BACKGROUND_CONTEXT);
		if (observation && revision === 0) accept(observation.value, BACKGROUND_CONTEXT);
		return observation;
	}

	/** Count a chat's failed attachment against the retry bound, and reattach within it. */
	#retry(id: number) {
		this.#failures.set(id, (this.#failures.get(id) ?? 0) + 1);
		this.#queueSync();
	}

	/** An ended observation never freezes a status: drop it, show what is still known, and reattach a bounded number of times. */
	#ended(id: number, end: WatchEnd) {
		if (this.#closed) return;
		this.#report(end);
		if (!this.#attached.has(id)) return;
		this.#detach(id);
		this.#publish(BACKGROUND_CONTEXT);
		this.#retry(id);
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
		const shown = this.#published.value.items;
		if (items.length === shown.length && items.every((item, index) => shown[index]?.id === item.id && shown[index].status === item.status)) return;
		this.#published.set({ items }, context);
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
