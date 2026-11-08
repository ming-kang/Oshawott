import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	AgentDoc, defineExtension, defineTool, type Extension, type InboxState, LiveDoc, type LiveState, MemoryStorage, type Storage,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Browser } from "../src/contracts/browser.ts";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal } from "../src/contracts/hosts.ts";
import { chatStatus } from "../src/engine/activity.ts";
import { startEngine } from "../src/engine/engine.ts";
import { ChatFiles, type FileBackend, MemoryFileBackend } from "../src/engine/files.ts";
import { WorkspaceDoc } from "../src/engine/docs.ts";
import { DEFAULT_INSTRUCTIONS } from "../src/engine/instructions.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet, memoryLinkPair, obj } from "../src/lib/chord.ts";

const context = BACKGROUND_CONTEXT;

async function until<T>(read: () => T | undefined, what: string, ms = 5_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function deferred() {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	return { promise, resolve, reject };
}

async function fixture(responses: FauxResponseStep[], options: {
	storage?: Storage;
	files?: FileBackend;
	extensions?: readonly Extension[];
	titleTimeoutMs?: number;
} = {}) {
	const errors: unknown[] = [];
	const onError = (error: unknown) => {
		if (!/closed|released|aborted|injected|timeout/i.test(JSON.stringify(error) + String(error))) errors.push(error);
	};
	let resume = () => {};
	let closed = false;
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError });
	await broker.load([{ name: "broker", facet: defineFacet<Principal>((host) => {
		host.serve(Browser, () => ({ variant: "engine", members: {
			listTabs: async () => [], activeTab: async () => null, openTab: async () => { throw new Error("unused"); },
			attach: async () => null, hasAccess: async () => false,
			armWake: async ({ at }) => {
				if (wakeTimer !== undefined) clearTimeout(wakeTimer);
				wakeTimer = undefined;
				if (at !== undefined) wakeTimer = setTimeout(() => { wakeTimer = undefined; resume(); }, Math.max(0, at - Date.now()));
				return null;
			},
		} }));
	}) }], context);
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses(responses);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const files = options.files ?? new MemoryFileBackend();
	const engine = await startEngine({
		storage: options.storage ?? new MemoryStorage(), models, credentials: new InMemoryCredentialStore(), files,
		broker: async () => {
			const [engineEnd, brokerEnd] = memoryLinkPair();
			broker.accept(brokerEnd, { principal: { kind: "engine" } }, context);
			return engineEnd;
		},
		tab: async () => { throw new Error("unused"); }, extensions: options.extensions,
		titleTimeoutMs: options.titleTimeoutMs, onError,
	}, context);
	resume = () => { if (!closed) engine.harness.resume(); };
	const panel = createHost<Principal>({ onError });
	const [panelEnd, engineEnd] = memoryLinkPair();
	engine.acceptPanel(engineEnd, "panel-1");
	panel.connect(panelEnd, { principal: { kind: "engine" } }, context);
	await panel.load([], context);
	const workspace = await panel.get(Workspace, {}, context);
	assert.equal(workspace.variant, "owner");
	const model = faux.getModel();
	await workspace.setDefaultModel({ provider: model.provider, modelId: model.id }, context);
	const chats = new Set<{ release(): void }>();
	return {
		faux, engine, workspace, files, errors,
		async chat(id: number) {
			const held = await panel.get(Chat, { id }, context);
			assert.equal(held.variant, "owner");
			chats.add(held);
			return held;
		},
		async close() {
			closed = true;
			if (wakeTimer !== undefined) clearTimeout(wakeTimer);
			for (const chat of chats) chat.release();
			workspace.release();
			await panel.close(context);
			await engine.close();
			await broker.close(context);
			assert.deepEqual(errors, []);
		},
	};
}

const summary = (workspace: Awaited<ReturnType<typeof fixture>>["workspace"], id: number) =>
	workspace.chats.value.find((chat) => chat.id === id);

test("list status distinguishes queued waits and ignores intentional aborts", () => {
	const inbox = { items: [{ id: 1, mode: "followUp", content: "later" }] } as unknown as InboxState;
	assert.equal(chatStatus({ inbox }, []), "waiting");
	const aborted = { runFailure: { reason: "aborted", taskId: 1, inputs: [] } } as unknown as LiveState;
	assert.equal(chatStatus({ live: aborted }, []), "idle");
	const failed = { runFailure: { reason: "model_error", taskId: 1, inputs: [] } } as unknown as LiveState;
	assert.equal(chatStatus({ live: failed, inbox }, []), "failed", "a real failure remains visible even with queued follow-ups");
});

test("conversation preferences and global instructions survive an Engine restart", async () => {
	const memory = new MemoryStorage();
	const storage = new Proxy(memory, {
		get(target, key) {
			if (key === "close") return async () => {};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const first = await fixture([], { storage });
	let id = 0;
	await first.workspace.setAutoTitle(true, context);
	await first.workspace.setAutoCompaction(false, context);
	await first.workspace.setAutoRetry(false, context);
	await first.workspace.setInstructions({ instructions: "Persistent global instructions" }, context);
	id = await first.workspace.createChat({ title: "Persistent title" }, context);
	await first.close();

	const second = await fixture([], { storage });
	try {
		assert.equal(second.workspace.autoTitle.value, true);
		assert.equal(second.workspace.autoCompaction.value, false);
		assert.equal(second.workspace.autoRetry.value, false);
		assert.equal(second.workspace.instructions.value, "Persistent global instructions");
		assert.equal(summary(second.workspace, id)?.title, "Persistent title");
		assert.equal((await second.engine.harness.snapshot(AgentDoc, id as never, context))?.instructions, "Persistent global instructions");
	} finally {
		await second.close();
	}
});

test("chat metadata and preferences synchronize across panels", async () => {
	const f = await fixture([]);
	const secondPanel = createHost<Principal>({ onError: (error) => f.errors.push(error) });
	const [panelEnd, engineEnd] = memoryLinkPair();
	f.engine.acceptPanel(engineEnd, "panel-2");
	secondPanel.connect(panelEnd, { principal: { kind: "engine" } }, context);
	await secondPanel.load([], context);
	const other = await secondPanel.get(Workspace, {}, context);
	assert.equal(other.variant, "owner");
	try {
		const id = await f.workspace.createChat({ title: "Before sync" }, context);
		await until(() => other.chats.value.some((chat) => chat.id === id) ? true : undefined, "the second panel's chat");
		await f.workspace.setAutoTitle(true, context);
		await other.setInstructions({ instructions: "Instructions from panel two" }, context);
		await until(() => f.workspace.autoTitle.value && f.workspace.instructions.value === "Instructions from panel two" ? true : undefined, "shared preferences");
		await other.renameChat({ id, title: "After sync" }, context);
		await until(() => summary(f.workspace, id)?.title === "After sync" ? true : undefined, "the renamed title in panel one");
	} finally {
		other.release();
		await secondPanel.close(context);
		await f.close();
	}
});

test("global instructions reach real requests and preferences and manual titles retain their semantics", async () => {
	const requests: TranscriptContext[] = [];
	const f = await fixture(Array.from({ length: 2 }, (_, index) => (request: TranscriptContext) => {
		requests.push(request);
		return fauxAssistantMessage(`Answer ${index + 1}`);
	}));
	try {
		assert.equal(f.workspace.autoTitle.value, false, "automatic titles are opt-in");
		assert.equal(f.workspace.autoCompaction.value, true);
		assert.equal(f.workspace.autoRetry.value, true);
		await f.workspace.setInstructions({ instructions: "Always mention the otter checklist." }, context);
		await f.workspace.setAutoCompaction(false, context);
		await f.workspace.setAutoRetry(false, context);
		const id = await f.workspace.createChat({}, context);
		const chat = await f.chat(id);
		assert.equal((await f.engine.harness.snapshot(AgentDoc, id as never, context))?.instructions, "Always mention the otter checklist.");
		await chat.send({ text: "First question", requestId: "first" }, context);
		await until(() => requests.length === 1 ? true : undefined, "the first model request");
		assert.match(JSON.stringify(requests[0]!.messages), /Always mention the otter checklist\./);

		await f.workspace.resetInstructions(context);
		await until(() => f.workspace.instructions.value === DEFAULT_INSTRUCTIONS ? true : undefined, "the restored instructions");
		await chat.send({ text: "Second question", requestId: "second" }, context);
		await until(() => requests.length === 2 ? true : undefined, "the second model request");
		const latestSystem = requests[1]!.messages.filter((message) => message.role === "system").at(-1);
		assert.match(latestSystem?.sections?.instructions ?? "", /You are Oshawott/);
		assert.doesNotMatch(latestSystem?.sections?.instructions ?? "", /Always mention the otter checklist/);
		assert.equal(f.workspace.autoCompaction.value, false);
		assert.equal(f.workspace.autoRetry.value, false);

		await f.workspace.renameChat({ id, title: "A manual title" }, context);
		await until(() => summary(f.workspace, id)?.title === "A manual title" ? true : undefined, "the manual rename");
		await f.workspace.renameChat({ id, title: "  " }, context);
		await until(() => summary(f.workspace, id)?.title === "First question" ? true : undefined, "the empty-title fallback");
		assert.equal(f.faux.state.callCount, 2, "neither settings nor renames generate hidden title requests");
	} finally {
		await f.close();
	}
});

test("automatic titles run once after a normal first answer and never overwrite a manual rename", async () => {
	const titleStarted = deferred();
	const releaseTitle = deferred();
	let titleOptions: { maxRetries?: number; maxTokens?: number } | undefined;
	const f = await fixture([
		fauxAssistantMessage("Use the reset button in settings."),
		(_request, options) => {
			titleOptions = options;
			return fauxAssistantMessage("Title: \"Reset onboarding\"");
		},
		fauxAssistantMessage("The second answer."),
		async () => {
			titleStarted.resolve();
			await releaseTitle.promise;
			return fauxAssistantMessage("Generated too late");
		},
		fauxAssistantMessage("Model failed", { stopReason: "error", errorMessage: "injected failure" }),
	]);
	try {
		await f.workspace.setAutoTitle(true, context);
		await f.workspace.setAutoRetry(false, context);
		const first = await f.workspace.createChat({}, context);
		const firstChat = await f.chat(first);
		await firstChat.send({ text: "How do I reset onboarding?", requestId: "title-first" }, context);
		const title = await until(() => summary(f.workspace, first)?.title === "Reset onboarding" ? true : undefined, "the generated title");
		assert.equal(title, true);
		assert.equal(f.faux.state.callCount, 2, "one conversation request and one title request");
		assert.equal(titleOptions?.maxRetries, 0);
		assert.equal(titleOptions?.maxTokens, 64);

		const second = await f.workspace.createChat({}, context);
		const secondChat = await f.chat(second);
		await secondChat.send({ text: "A second conversation", requestId: "title-second" }, context);
		await titleStarted.promise;
		await f.workspace.renameChat({ id: second, title: "Manual before completion" }, context);
		releaseTitle.resolve();
		await until(() => f.faux.state.callCount === 4 ? true : undefined, "the late title response");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(summary(f.workspace, second)?.title, "Manual before completion");

		const failed = await f.workspace.createChat({}, context);
		const failedChat = await f.chat(failed);
		await failedChat.send({ text: "This run fails", requestId: "title-failed" }, context);
		await until(() => summary(f.workspace, failed)?.status === "failed" ? true : undefined, "the failed list status");
		assert.equal((await f.engine.harness.snapshot(LiveDoc, failed as never, context))?.runFailure?.reason, "model_error");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(f.faux.state.callCount, 5, "a failed first run never triggers a title request");
		assert.equal(summary(f.workspace, failed)?.title, "This run fails");
	} finally {
		releaseTitle.resolve();
		await f.close();
	}
});

test("a title timeout retains the fallback and does not retry", async () => {
	const titleStarted = deferred();
	const f = await fixture([
		fauxAssistantMessage("A normal answer"),
		async (_request, options) => {
			titleStarted.resolve();
			await new Promise<void>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("title timeout")), { once: true });
			});
			return fauxAssistantMessage("Unreachable title");
		},
	], { titleTimeoutMs: 30 });
	try {
		await f.workspace.setAutoTitle(true, context);
		const id = await f.workspace.createChat({}, context);
		const chat = await f.chat(id);
		await chat.send({ text: "Keep the fallback", requestId: "title-timeout" }, context);
		await titleStarted.promise;
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(summary(f.workspace, id)?.title, "Keep the fallback");
		assert.equal(f.faux.state.callCount, 2);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(f.faux.state.callCount, 2, "timeout does not cause another request");
	} finally {
		await f.close();
	}
});

test("the failure-retry preference changes real retry behavior without a second policy", async () => {
	const transient = () => { throw new Error("injected retry failure: HTTP 503 overloaded"); };
	const f = await fixture([transient, fauxAssistantMessage("Recovered")]);
	try {
		const id = await f.workspace.createChat({}, context);
		const chat = await f.chat(id);
		await chat.send({ text: "Retry once", requestId: "retry-enabled" }, context);
		await until(() => chat.view.value?.entries.some((entry) => entry.model?.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "text" && part.text === "Recovered"))) ? true : undefined, "the bounded retry response");
		assert.equal(f.faux.state.callCount, 2);

		await f.workspace.setAutoRetry(false, context);
		f.faux.setResponses([transient, fauxAssistantMessage("Must remain unused")]);
		const stoppedId = await f.workspace.createChat({}, context);
		const stopped = await f.chat(stoppedId);
		await stopped.send({ text: "Do not retry", requestId: "retry-disabled" }, context);
		await until(() => stopped.view.value?.docs["pi.live"]?.runFailure ? true : undefined, "the disabled-retry failure");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(f.faux.state.callCount, 3, "disabling retry consumes only the failed request");
		assert.equal(stopped.view.value?.docs["pi.live"]?.run, undefined);
		assert.equal(summary(f.workspace, stoppedId)?.status, "failed");
	} finally {
		await f.close();
	}
});

test("background status comes from Durable and reset cancels the old queue but keeps files", async () => {
	const started = deferred();
	const release = deferred();
	const hold = defineTool({
		name: "hold", description: "Wait for the test.", parameters: obj({}), replay: "unsafe",
		execute: async () => {
			started.resolve();
			await release.promise;
			return { output: [{ type: "text" as const, text: "released" }] };
		},
	});
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Must not run after reset"),
	], { extensions: [defineExtension({ name: "conversation-ux-test", tools: [hold] })] });
	try {
		const id = await f.workspace.createChat({}, context);
		const chat = await f.chat(id);
		getOrThrow(await new ChatFiles(f.files, id).writeFile("keep.txt", "keep me", context));
		await chat.send({ text: "Start", requestId: "reset-start" }, context);
		await started.promise;
		await until(() => summary(f.workspace, id)?.status === "running" ? true : undefined, "the background running status");
		await chat.send({ text: "Old queued input", requestId: "reset-queued", whenBusy: "followUp" }, context);
		await until(() => {
			const inbox = chat.view.value?.docs["pi.inbox"] as InboxState | undefined;
			return inbox?.items.length === 1 ? true : undefined;
		}, "the queued input");
		const resetting = chat.reset(context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		release.resolve();
		await resetting;
		await until(() => summary(f.workspace, id)?.status === "idle" ? true : undefined, "the idle status after reset");
		assert.ok(chat.view.value?.entries.some((entry) => entry.kind === "pi.reset"));
		assert.deepEqual((await chat.files(context)).map((file) => file.path), ["keep.txt"]);
		assert.equal(new TextDecoder().decode(await chat.readFile({ path: "keep.txt" }, context)), "keep me");
		assert.equal(f.faux.state.callCount, 1, "the old queued input never reaches the model in the new context");
		await f.workspace.deleteChat({ id }, context);
		assert.deepEqual(getOrThrow(await new ChatFiles(f.files, id).workspaceFiles(context)), []);
	} finally {
		release.resolve();
		await f.close();
	}
});

test("blank or built-in instructions select the built-in text and other text is stored as typed", async () => {
	const f = await fixture([]);
	try {
		const id = await f.workspace.createChat({}, context);
		await f.workspace.setInstructions({ instructions: "  Keep my\n  indentation.\n" }, context);
		await until(() => f.workspace.instructions.value === "  Keep my\n  indentation.\n" ? true : undefined, "the typed instructions");
		await f.workspace.setInstructions({ instructions: " \n\t " }, context);
		await until(() => f.workspace.instructions.value === DEFAULT_INSTRUCTIONS ? true : undefined, "blank instructions restoring the built-in text");
		assert.equal((await f.engine.harness.snapshot(AgentDoc, id as never, context))?.instructions, DEFAULT_INSTRUCTIONS);
		assert.equal((await f.engine.harness.snapshot(WorkspaceDoc, context))?.instructions, undefined, "the built-in text is not copied into storage");
	} finally {
		await f.close();
	}
});

test("clearing the title of an unsent chat still shows the first message and never generates a title", async () => {
	const f = await fixture([fauxAssistantMessage("Answer"), fauxAssistantMessage("Unwanted title")]);
	try {
		await f.workspace.setAutoTitle(true, context);
		const id = await f.workspace.createChat({ title: "Named" }, context);
		await f.workspace.renameChat({ id, title: "" }, context);
		await until(() => summary(f.workspace, id)?.title === "" ? true : undefined, "the cleared title");
		const chat = await f.chat(id);
		await chat.send({ text: "First message title", requestId: "cleared" }, context);
		await until(() => summary(f.workspace, id)?.title === "First message title" ? true : undefined, "the fallback title");
		await until(() => summary(f.workspace, id)?.status === "idle" && f.faux.state.callCount === 1 ? true : undefined, "the finished run");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(f.faux.state.callCount, 1, "a manual decision is never followed by a title request");
		assert.equal(summary(f.workspace, id)?.title, "First message title");
	} finally {
		await f.close();
	}
});

test("a disabled retry policy applies to runs recovered by a restarted Engine", async () => {
	const memory = new MemoryStorage();
	const storage = new Proxy(memory, {
		get(target, key) {
			if (key === "close") return async () => {};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const started = deferred();
	const first = await fixture([async (_request, options) => {
		started.resolve();
		await new Promise<void>((_resolve, reject) => {
			options?.signal?.addEventListener("abort", () => reject(new Error("closed by the test")), { once: true });
		});
		return fauxAssistantMessage("Unreachable");
	}], { storage });
	await first.workspace.setAutoRetry(false, context);
	const id = await first.workspace.createChat({}, context);
	const chat = await first.chat(id);
	await chat.send({ text: "Survive a restart", requestId: "recovered" }, context);
	await started.promise;
	await first.close();

	const transient = () => { throw new Error("injected retry failure: HTTP 503 overloaded"); };
	const second = await fixture([transient, fauxAssistantMessage("Must remain unused")], { storage });
	try {
		await until(() => summary(second.workspace, id)?.status === "failed" ? true : undefined, "the recovered run failing", 10_000);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(second.faux.state.callCount, 1, "the recovered run does not retry under the default policy");
	} finally {
		await second.close();
	}
});

test("activity time advances once per finished run, not per streamed entry", async () => {
	let now = 1_000;
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("missing_tool", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done"),
	]);
	try {
		const id = await f.workspace.createChat({}, context);
		const chat = await f.chat(id);
		const seen = new Set<number>();
		const watch = await f.workspace.chats.watch(context);
		watch.start(async () => { const value = summary(f.workspace, id)?.updatedAt; if (value !== undefined) seen.add(value); });
		await chat.send({ text: "Go", requestId: "activity" }, context);
		await until(() => summary(f.workspace, id)?.status === "running" ? true : undefined, "the running status");
		await until(() => summary(f.workspace, id)?.status === "idle" && f.faux.state.callCount === 2 ? true : undefined, "the finished run");
		const after = await until(() => {
			const value = summary(f.workspace, id)?.updatedAt;
			return value !== undefined && seen.size >= 2 ? value : undefined;
		}, "the activity update");
		assert.ok(seen.size <= 3, `creation, send and finish only; saw ${seen.size}`);
		assert.ok(after >= now);
		watch.stop?.();
	} finally {
		await f.close();
	}
});
