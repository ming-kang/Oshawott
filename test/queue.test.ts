import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type InboxItem, type InboxState, MemoryStorage, type Storage, type SubmissionId } from "@earendil-works/pi-durable";
import { Browser } from "../src/contracts/browser.ts";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal } from "../src/contracts/hosts.ts";
import { startEngine } from "../src/engine/engine.ts";
import { MemoryFileBackend } from "../src/engine/files.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet, obj, type Reference } from "../src/lib/chord.ts";
import { portLink } from "../src/link/port-link.ts";
import { fakePortPair } from "./fake-port.ts";

const context = BACKGROUND_CONTEXT;
type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function until<T>(read: () => T | undefined, what: string, ms = 5_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function userTexts(messages: readonly Message[]): string[] {
	return messages.filter((message) => message.role === "user").map((message) =>
		typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join(""),
	);
}

function queued(chat: ChatRef) {
	const inbox = chat.view.value?.docs["pi.inbox"] as InboxState | undefined;
	return (inbox?.items ?? []).filter((item): item is Extract<InboxItem, { mode: "steer" | "followUp" }> => item.mode === "steer" || item.mode === "followUp");
}

function visibleUsers(chat: ChatRef): string[] {
	return (chat.view.value?.entries ?? []).filter((entry) => entry.kind === "pi.user").flatMap((entry) =>
		(entry.model ?? []).filter((message) => message.role === "user").map((message) =>
			typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join(""),
		),
	);
}

async function fixture(responses: FauxResponseStep[], options: { storage?: Storage; chatId?: number } = {}) {
	const started = deferred();
	const release = deferred();
	const hold = defineTool({
		name: "hold",
		description: "Wait until the test releases the tool boundary.",
		parameters: obj({}),
		replay: "unsafe",
		execute: async () => {
			started.resolve();
			await release.promise;
			return { output: [{ type: "text" as const, text: "released" }] };
		},
	});
	const onError = (error: unknown) => {
		if (!/closed|released|aborted/i.test(JSON.stringify(error) + String(error))) throw error;
	};
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError });
	await broker.load([{
		name: "broker",
		facet: defineFacet<Principal>((host) => {
			host.serve(Browser, () => ({
				variant: "engine",
				members: {
					listTabs: async () => [], activeTab: async () => null, openTab: async () => { throw new Error("unused"); },
					attach: async () => null, hasAccess: async () => false, armWake: async () => null,
				},
			}));
		}),
	}], context);
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(responses);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const engine = await startEngine({
		storage: options.storage ?? new MemoryStorage(), models, credentials: new InMemoryCredentialStore(), files: new MemoryFileBackend(),
		broker: async () => {
			const [engineEnd, brokerEnd] = fakePortPair();
			broker.accept(portLink(brokerEnd), { principal: { kind: "engine" } }, context);
			return portLink(engineEnd);
		},
		tab: async () => { throw new Error("unused"); },
		extensions: [defineExtension({ name: "queue-test", tools: [hold] })],
		onError,
	}, context);
	const [panelEnd, engineEnd] = fakePortPair("oshawott:panel");
	engine.acceptPanel(portLink(engineEnd), "panel-1");
	const panel = createHost<Principal>({ onError });
	panel.connect(portLink(panelEnd), { principal: { kind: "engine" } }, context);
	await panel.load([], context);
	const workspace = await panel.get(Workspace, {}, context);
	assert.equal(workspace.variant, "owner");
	const model = faux.getModel();
	await workspace.setDefaultModel({ provider: model.provider, modelId: model.id }, context);
	const id = options.chatId ?? await workspace.createChat({}, context);
	const chat = await panel.get(Chat, { id }, context);
	assert.equal(chat.variant, "owner");
	return {
		chat, workspace, engine, id, started, release, faux,
		async connectChat() {
			const [otherPanelEnd, otherEngineEnd] = fakePortPair("oshawott:panel");
			engine.acceptPanel(portLink(otherEngineEnd), "panel-2");
			const otherPanel = createHost<Principal>({ onError });
			otherPanel.connect(portLink(otherPanelEnd), { principal: { kind: "engine" } }, context);
			await otherPanel.load([], context);
			const otherChat = await otherPanel.get(Chat, { id }, context);
			assert.equal(otherChat.variant, "owner");
			return { chat: otherChat, close: async () => { otherChat.release(); await otherPanel.close(context); } };
		},
		async close() {
			release.resolve();
			chat.release();
			workspace.release();
			await panel.close(context);
			await engine.close();
			await broker.close(context);
		},
	};
}

test("steer enters after the current tool while followUp waits for the final answer", async () => {
	let secondUsers: string[] | undefined;
	let thirdUsers: string[] | undefined;
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		(request) => {
			secondUsers = userTexts(request.messages);
			return fauxAssistantMessage("First answer");
		},
		(request) => {
			thirdUsers = userTexts(request.messages);
			return fauxAssistantMessage("Follow-up answer");
		},
	]);
	try {
		const firstId = await f.chat.send({ text: "Start", requestId: "start" }, context);
		assert.equal(typeof firstId, "number");
		await f.started.promise;
		await assert.rejects(f.chat.send({ text: "   ", requestId: "blank", whenBusy: "followUp" }, context), /cannot be empty/);
		const steerId = await f.chat.send({ text: "Original steer", requestId: "steer", whenBusy: "steer" }, context);
		const duplicateId = await f.chat.send({ text: "Duplicate must not appear", requestId: "steer", whenBusy: "steer" }, context);
		assert.equal(duplicateId, steerId, "a request ID returns its original durable submission");
		await f.chat.send({ text: "Later", requestId: "later", whenBusy: "followUp" }, context);
		await until(() => queued(f.chat).length === 2 || undefined, "both queued inputs");
		assert.equal(queued(f.chat).filter((item) => item.id === steerId).length, 1);
		assert.deepEqual(visibleUsers(f.chat), ["Start"]);
		assert.equal(await f.chat.updateQueued({ id: steerId, text: "Edited steer" }, context), "updated");

		f.release.resolve();
		await until(() => secondUsers, "the post-tools model request");
		assert.deepEqual(secondUsers, ["Start", "Edited steer"]);
		assert.ok(!secondUsers!.includes("Later"), "followUp is absent from the current run");
		await until(() => thirdUsers, "the follow-up run");
		assert.deepEqual(thirdUsers, ["Start", "Edited steer", "Later"]);
		await until(() => queued(f.chat).length === 0 || undefined, "the drained inbox");
		assert.deepEqual(visibleUsers(f.chat), ["Start", "Edited steer", "Later"]);
	} finally {
		await f.close();
	}
});

test("queued messages support editing, both mode changes, cancellation, and stale operations", async () => {
	let secondUsers: string[] | undefined;
	let thirdUsers: string[] | undefined;
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		(request) => { secondUsers = userTexts(request.messages); return fauxAssistantMessage("First answer"); },
		(request) => { thirdUsers = userTexts(request.messages); return fauxAssistantMessage("Second answer"); },
	]);
	try {
		await f.chat.send({ text: "Start", requestId: "start" }, context);
		await f.started.promise;
		const edited = await f.chat.send({ text: "Before edit", requestId: "edit", whenBusy: "followUp" }, context);
		const demoted = await f.chat.send({ text: "Demoted", requestId: "demote", whenBusy: "steer" }, context);
		const cancelled = await f.chat.send({ text: "Cancelled", requestId: "cancel", whenBusy: "followUp" }, context);
		await until(() => queued(f.chat).length === 3 || undefined, "three queued inputs");
		assert.equal(await f.chat.updateQueued({ id: edited, text: "Edited and promoted", whenBusy: "steer" }, context), "updated");
		assert.equal(await f.chat.updateQueued({ id: demoted, whenBusy: "followUp" }, context), "updated");
		assert.equal(await f.chat.cancelQueued({ id: cancelled }, context), "aborted");
		assert.equal(await f.chat.cancelQueued({ id: cancelled }, context), "settled");
		assert.equal(await f.chat.updateQueued({ id: cancelled, text: "Too late" }, context), "not_found");
		await assert.rejects(f.chat.updateQueued({ id: edited }, context), /Nothing to update/);
		await assert.rejects(f.chat.updateQueued({ id: edited, text: "   " }, context), /cannot be empty/);

		f.release.resolve();
		await until(() => secondUsers, "the post-tools request");
		assert.deepEqual(secondUsers, ["Start", "Edited and promoted"]);
		await until(() => thirdUsers, "the demoted follow-up");
		assert.deepEqual(thirdUsers, ["Start", "Edited and promoted", "Demoted"]);
		assert.ok(!visibleUsers(f.chat).includes("Cancelled"));
		assert.ok(!visibleUsers(f.chat).includes("Before edit"));
	} finally {
		await f.close();
	}
});

test("a failed run keeps follow-ups and continueQueued drains them without duplication", async () => {
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Expected failure", { stopReason: "error", errorMessage: "Expected failure" }),
		fauxAssistantMessage("Recovered"),
	]);
	try {
		await f.chat.send({ text: "Start", requestId: "start" }, context);
		await f.started.promise;
		await f.chat.send({ text: "After failure", requestId: "queued", whenBusy: "followUp" }, context);
		f.release.resolve();
		await until(() => {
			const live = f.chat.view.value?.docs["pi.live"] as { run?: unknown; runFailure?: unknown } | undefined;
			return !live?.run && live?.runFailure ? true : undefined;
		}, "the failed run");
		assert.equal(queued(f.chat).length, 1, "the default afterFailedRun policy keeps the input");
		assert.deepEqual(visibleUsers(f.chat), ["Start"]);
		const continuation = await f.chat.continueQueued(context);
		assert.equal(typeof continuation, "number");
		await until(() => visibleUsers(f.chat).includes("After failure") || undefined, "the queued user entry");
		await until(() => queued(f.chat).length === 0 || undefined, "the continued queue");
		assert.deepEqual(visibleUsers(f.chat), ["Start", "After failure"]);
	} finally {
		await f.close();
	}
});

test("two panels share one canonical inbox and stale edits cannot revive a cancelled input", async () => {
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("unused"),
	]);
	const second = await f.connectChat();
	try {
		await f.chat.send({ text: "Start", requestId: "start" }, context);
		await f.started.promise;
		const id = await f.chat.send({ text: "Original", requestId: "shared", whenBusy: "followUp" }, context);
		await until(() => queued(second.chat).length === 1 || undefined, "the second panel's inbox");
		assert.equal(await second.chat.updateQueued({ id, text: "Edited remotely", whenBusy: "steer" }, context), "updated");
		await until(() => {
			const item = queued(f.chat)[0];
			return item?.mode === "steer" && item.content === "Edited remotely" ? true : undefined;
		}, "the first panel's canonical update");
		assert.equal(await second.chat.cancelQueued({ id }, context), "aborted");
		await until(() => queued(f.chat).length === 0 || undefined, "the first panel's cancellation");
		assert.equal(await f.chat.updateQueued({ id, text: "Must not reappear" }, context), "not_found");
		assert.deepEqual(visibleUsers(f.chat), ["Start"]);
	} finally {
		await second.close();
		await f.close();
	}
});

test("queued submissions and their IDs survive an Engine restart", async () => {
	const memory = new MemoryStorage();
	const storage = new Proxy(memory, {
		get(target, key) {
			if (key === "close") return async () => {};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const hanging = async (_request: unknown, options?: { signal?: AbortSignal }) => {
		await new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
		return fauxAssistantMessage("unused");
	};
	const first = await fixture([hanging], { storage });
	const queuedId = await (async () => {
		try {
			assert.equal(first.workspace.busyMode.value, "steer");
			await first.workspace.setBusyMode("followUp", context);
			await first.chat.send({ text: "Start", requestId: "start" }, context);
			await until(() => first.faux.state.callCount === 1 || undefined, "the hanging model request");
			return await first.chat.send({ text: "Survives restart", requestId: "persistent", whenBusy: "followUp" }, context);
		} finally {
			await first.close();
		}
	})();
	const second = await fixture([hanging], { storage, chatId: first.id });
	try {
		await until(() => queued(second.chat).length === 1 || undefined, "the persisted inbox on the next Engine");
		assert.equal(second.workspace.busyMode.value, "followUp", "the delivery preference also survives restart");
		assert.equal(queued(second.chat)[0]?.id, queuedId);
		assert.equal(queued(second.chat)[0]?.content, "Survives restart");
		const submission = await second.engine.harness.submission(queuedId as SubmissionId, context);
		assert.equal((await submission?.status(context))?.status, "queued");
		assert.equal(await second.chat.cancelQueued({ id: queuedId }, context), "aborted");
	} finally {
		await second.close();
	}
});

test("abort withdraws every queued input and records it unanswered", async () => {
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("unused"),
	]);
	try {
		await f.chat.send({ text: "Start", requestId: "start" }, context);
		await f.started.promise;
		const steer = await f.chat.send({ text: "Steer", requestId: "steer", whenBusy: "steer" }, context);
		const followUp = await f.chat.send({ text: "Follow-up", requestId: "follow", whenBusy: "followUp" }, context);
		await until(() => queued(f.chat).length === 2 || undefined, "the queued inputs");
		const aborting = f.chat.abort(context);
		await until(() => queued(f.chat).length === 0 || undefined, "abort to withdraw the inbox before the tool ends");
		for (const id of [steer, followUp]) {
			const submission = await f.engine.harness.submission(id as SubmissionId, context);
			assert.equal((await submission?.status(context))?.status, "unanswered");
		}
		f.release.resolve();
		await aborting;
		assert.deepEqual(visibleUsers(f.chat), ["Start"]);
	} finally {
		await f.close();
	}
});
