import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Harness, InboxDoc, type InboxState, LiveDoc, type LiveState, type Observation, type Observer, type TaskId,
	type TaskGraph, type WatchCall,
} from "@earendil-works/pi-durable";
import { type ActivitySnapshot, ConversationActivity } from "../src/engine/activity.ts";
import type { WorkspaceChat } from "../src/engine/docs.ts";
import { BACKGROUND_CONTEXT, type Context } from "../src/lib/chord.ts";
import { until } from "./support/wait.ts";

/** A Workspace chat id is its conversation id, as the Workspace creates both from one counter. */
const chat = (id: number): WorkspaceChat => ({ id, title: `Chat ${id}`, createdAt: 0 });
const busy: LiveState = { run: { taskId: 1 as TaskId, inputs: [], turns: 1 } };
const docKey = (token: typeof LiveDoc | typeof InboxDoc, id: number) => `${token === LiveDoc ? "live" : "inbox"}:${id}`;

/**
 * The Harness surface ConversationActivity uses, offline: the task graph and each conversation's `pi.live` and `pi.inbox`.
 * It records every observation it hands out, so a test can see whether a failed attach leaked one, and it rejects
 * attaches on demand, so a test can fail one.
 */
class FakeDocs {
	readonly #graph: TaskGraph = { tasks: {} };
	readonly #values = new Map<string, unknown>();
	readonly #observers = new Map<string, Set<Observer<unknown>>>();
	readonly #detached = new Map<string, number>();
	readonly #attempts = new Map<string, number>();
	readonly #failures = new Map<string, { remaining: number; error: unknown }>();

	get harness(): Harness {
		return this as unknown as Harness;
	}

	async observeTaskGraph(_observer: Observer<TaskGraph>, _context: Context): Promise<Observation<TaskGraph>> {
		return { value: this.#graph, detach: () => {} };
	}

	observeDoc(token: typeof LiveDoc | typeof InboxDoc, conversationId: number, observer: Observer<unknown>, _context: Context): Promise<Observation<unknown> | undefined> {
		const key = docKey(token, conversationId);
		this.#attempts.set(key, (this.#attempts.get(key) ?? 0) + 1);
		const failure = this.#failures.get(key);
		if (failure !== undefined && failure.remaining > 0) {
			failure.remaining -= 1;
			return Promise.reject(failure.error);
		}
		const observers = this.#observers.get(key) ?? new Set<Observer<unknown>>();
		this.#observers.set(key, observers);
		observers.add(observer);
		const value = this.#values.get(key);
		return Promise.resolve({ value, detach: () => { observers.delete(observer); this.#detached.set(key, (this.#detached.get(key) ?? 0) + 1); } });
	}

	/** Reject the next `times` attaches of `token` for `id` with `error`; `Infinity` rejects every one of them. */
	fail(token: typeof LiveDoc | typeof InboxDoc, id: number, error: unknown, times = 1) {
		const key = docKey(token, id);
		const found = this.#failures.get(key);
		this.#failures.set(key, { remaining: (found?.remaining ?? 0) + times, error: found?.error ?? error });
	}

	setLive(id: number, value: LiveState) {
		this.#values.set(docKey(LiveDoc, id), value);
		this.#deliver(docKey(LiveDoc, id), value);
	}

	end(token: typeof LiveDoc | typeof InboxDoc, id: number) {
		for (const observer of [...this.#observers.get(docKey(token, id)) ?? []]) observer.end({ kind: "ended" });
	}

	/** The observations currently attached, and how many were released, for one document of one chat. */
	attached(token: typeof LiveDoc | typeof InboxDoc, id: number): number {
		return this.#observers.get(docKey(token, id))?.size ?? 0;
	}

	detached(token: typeof LiveDoc | typeof InboxDoc, id: number): number {
		return this.#detached.get(docKey(token, id)) ?? 0;
	}

	attempts(token: typeof LiveDoc | typeof InboxDoc, id: number): number {
		return this.#attempts.get(docKey(token, id)) ?? 0;
	}

	#deliver(key: string, value: LiveState | InboxState) {
		for (const observer of [...this.#observers.get(key) ?? []]) {
			const call: WatchCall<unknown> = { kind: "value", value, ops: [["r", value]], retired: false };
			observer.advance(call, BACKGROUND_CONTEXT);
		}
	}
}

/** An activity over `fake`, with the snapshot it publishes and the errors it reports. */
async function openActivity(fake: FakeDocs) {
	const errors: unknown[] = [];
	let snapshot: ActivitySnapshot = { items: [] };
	const activity = new ConversationActivity({ harness: fake.harness, now: () => 0, onError: (error) => errors.push(error) });
	await activity.observe({
		advance: (call) => { if (call.kind === "value") snapshot = call.value; },
		end: () => {},
	});
	await activity.start(BACKGROUND_CONTEXT);
	return { activity, errors, status: (id: number) => snapshot.items.find((item) => item.id === id)?.status };
}

test("a failed initial live observation is reported and the chat recovers on a later sync", async () => {
	const fake = new FakeDocs();
	const failure = new Error("injected live attach failure");
	fake.fail(LiveDoc, 1, failure);
	const { activity, errors, status } = await openActivity(fake);
	try {
		activity.setChats([chat(1)], BACKGROUND_CONTEXT);
		await until(() => errors.length === 1, "the reported attach failure");
		assert.equal(errors[0], failure);
		assert.equal(status(1), "idle", "a chat that could not be observed shows nothing rather than a stale status");

		// The failed attach is forgotten, so a later sync attaches the chat again.
		activity.setChats([chat(1)], BACKGROUND_CONTEXT);
		fake.setLive(1, busy);
		await until(() => status(1) === "running", "the recovered running status");
		assert.equal(fake.attached(LiveDoc, 1), 1, "the retried live observation stays attached");
		assert.equal(fake.attached(InboxDoc, 1), 1);
	} finally {
		activity.close();
	}
	assert.equal(fake.attached(LiveDoc, 1) + fake.attached(InboxDoc, 1), 0, "closing releases every observation");
});

test("a failed initial inbox observation releases the live observation it already created", async () => {
	const fake = new FakeDocs();
	const failure = new Error("injected inbox attach failure");
	fake.fail(InboxDoc, 1, failure);
	const { activity, errors, status } = await openActivity(fake);
	try {
		activity.setChats([chat(1)], BACKGROUND_CONTEXT);
		await until(() => errors.length === 1, "the reported attach failure");
		assert.equal(errors[0], failure);
		// The attempt releases the observation it had already created instead of leaking it.
		assert.equal(fake.detached(LiveDoc, 1), 1, "the live observation is released, not leaked");
		assert.equal(status(1), "idle");

		activity.setChats([chat(1)], BACKGROUND_CONTEXT);
		fake.setLive(1, busy);
		await until(() => status(1) === "running", "the recovered running status");
		assert.equal(fake.attached(LiveDoc, 1), 1, "one live observation is attached, not one per attempt");
		assert.equal(fake.attached(InboxDoc, 1), 1);
	} finally {
		activity.close();
	}
	assert.equal(fake.attached(LiveDoc, 1) + fake.attached(InboxDoc, 1), 0, "closing releases every observation");
});

test("both initial observation failures are retained in one reported error", async () => {
	const fake = new FakeDocs();
	const liveFailure = new Error("injected live failure");
	const inboxFailure = new Error("injected inbox failure");
	fake.fail(LiveDoc, 1, liveFailure);
	fake.fail(InboxDoc, 1, inboxFailure);
	const { activity, errors } = await openActivity(fake);
	try {
		activity.setChats([chat(1)], BACKGROUND_CONTEXT);
		await until(() => errors.length === 1, "the combined attach failure");
		const error = errors[0];
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(new Set(error.errors), new Set([liveFailure, inboxFailure]));
	} finally {
		activity.close();
	}
});

test("a successful attach resets the consecutive failure budget", async () => {
	const fake = new FakeDocs();
	fake.fail(LiveDoc, 1, new Error("injected initial failure"));
	fake.setLive(1, busy);
	const { activity, status } = await openActivity(fake);
	try {
		activity.setChats([chat(1)], BACKGROUND_CONTEXT);
		await until(() => status(1) === "running", "the first successful attach");
		for (let cycle = 0; cycle < 3; cycle++) {
			const attempts = fake.attempts(LiveDoc, 1);
			fake.end(LiveDoc, 1);
			await until(() => fake.attempts(LiveDoc, 1) === attempts + 1 && status(1) === "running",
				`successful reattach ${cycle + 1}`);
		}
	} finally {
		activity.close();
	}
	assert.equal(fake.attached(LiveDoc, 1) + fake.attached(InboxDoc, 1), 0);
});

test("an attach that keeps failing is retried a bounded number of times", async () => {
	const fake = new FakeDocs();
	fake.fail(LiveDoc, 1, new Error("injected persistent failure"), Infinity);
	const { activity, errors, status } = await openActivity(fake);
	try {
		activity.setChats([chat(1)], BACKGROUND_CONTEXT);
		await until(() => errors.length > 0, "the first reported failure");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const settled = fake.attempts(LiveDoc, 1);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(fake.attempts(LiveDoc, 1), settled, "the retries stop instead of repeating forever");
		assert.equal(errors.length, settled, "every failure is reported once");
		assert.equal(status(1), "idle", "a chat that cannot be observed is shown idle");
		assert.equal(fake.attached(LiveDoc, 1) + fake.attached(InboxDoc, 1), 0, "no attempt leaves an observation behind");
	} finally {
		activity.close();
	}
});
