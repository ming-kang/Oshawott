import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep, type Message, type UserMessage } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type InboxItem, type InboxState, MemoryStorage, type Storage, type SubmissionId } from "@earendil-works/pi-durable";
import { Browser } from "../src/contracts/browser.ts";
import { attachmentRefs, editableText } from "../src/lib/attachments.ts";
import { fromBase64, toBase64 } from "../src/lib/base64.ts";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal } from "../src/contracts/hosts.ts";
import { resumeAttachmentDeletes } from "../src/engine/attachments.ts";
import { startEngine } from "../src/engine/engine.ts";
import { type FileBackend, type FileTx, MemoryFileBackend } from "../src/engine/files.ts";
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

async function fixture(responses: FauxResponseStep[], options: { storage?: Storage; chatId?: number; modelInput?: ("text" | "image")[]; files?: FileBackend } = {}) {
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
	const faux = fauxProvider({ models: [{ id: "faux-1", ...(options.modelInput ? { input: options.modelInput } : {}) }] });
	faux.setResponses(responses);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const engine = await startEngine({
		storage: options.storage ?? new MemoryStorage(), models, credentials: new InMemoryCredentialStore(), files: options.files ?? new MemoryFileBackend(),
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

const PNG = fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
const utf8 = new TextEncoder();

test("image and text attachments reach the model and the same bytes are downloadable", async () => {
	let content: UserMessage["content"] | undefined;
	const f = await fixture([(request) => {
		content = ([...request.messages].reverse().find((message) => message.role === "user") as UserMessage | undefined)?.content;
		return fauxAssistantMessage("Seen");
	}]);
	try {
		const submission = await f.chat.send({ text: "", requestId: "attachments", attachments: [
			{ id: "pixel", name: "pixel.png", mimeType: "image/png", data: PNG },
			{ id: "notes", name: "notes.txt", mimeType: "text/plain", data: utf8.encode("full private file body") },
		] }, context);
		await until(() => content, "the attachment model request");
		assert.ok(Array.isArray(content));
		const blocks = content as Exclude<UserMessage["content"], string>;
		const image = blocks.find((block) => block.type === "image");
		assert.equal(image?.type === "image" && image.data, toBase64(PNG));
		assert.equal(editableText(content), "");
		assert.equal(attachmentRefs(content).length, 2);
		assert.ok(!JSON.stringify(content).includes("full private file body"), "text files are not inlined");
		const files = await f.chat.files(context);
		assert.equal(files.length, 2);
		const imageFile = files.find((file) => file.path.endsWith("pixel.png"));
		assert.deepEqual(await f.chat.readFile({ path: imageFile!.path }, context), PNG);
		assert.equal(f.workspace.chats.value.find((chat) => chat.id === f.id)?.title, "pixel.png, notes.txt");
		const duplicate = await f.chat.send({ text: "Not admitted twice", requestId: "attachments", attachments: [
			{ id: "new-id", name: "orphan.txt", mimeType: "text/plain", data: utf8.encode("must not persist") },
		] }, context);
		assert.equal(duplicate, submission);
		assert.equal((await f.chat.files(context)).length, 2, "a repeated request ID writes no new attachment files");
	} finally {
		await f.close();
	}
});

test("queued attachment edits preserve images, honor removals and clean cancelled files", async () => {
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("unused"),
	]);
	try {
		await f.chat.send({ text: "Start", requestId: "start" }, context);
		await f.started.promise;
		const id = await f.chat.send({ text: "Original", requestId: "queued-image", whenBusy: "followUp", attachments: [
			{ id: "pixel", name: "pixel.png", mimeType: "image/png", data: PNG },
		] }, context);
		await until(() => queued(f.chat).length === 1 || undefined, "the queued image");
		assert.equal(await f.chat.updateQueued({ id, text: "Edited" }, context), "updated");
		let content = queued(f.chat)[0]!.content;
		assert.equal(editableText(content), "Edited");
		assert.equal(attachmentRefs(content).length, 1);
		assert.equal(typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length, 1);
		await assert.rejects(f.chat.updateQueued({ id, removeAttachments: ["/workspace/attachments/../escape.txt"] }, context), /Not an attachment/);
		assert.equal(await f.chat.updateQueued({
			id, text: "Text only", requestId: "edit-attachments", removeAttachments: [attachmentRefs(content)[0]!.path],
			attachments: [{ id: "replacement", name: "replacement.txt", mimeType: "text/plain", data: utf8.encode("replacement") }],
		}, context), "updated");
		content = queued(f.chat)[0]!.content;
		assert.deepEqual(attachmentRefs(content).map((item) => item.name), ["replacement.txt"]);
		assert.equal(typeof content === "string" ? 0 : content.filter((block) => block.type === "image").length, 0);
		assert.equal((await f.chat.files(context)).some((file) => file.path.endsWith("pixel.png")), false);
		assert.equal(await f.chat.cancelQueued({ id }, context), "aborted");
		assert.deepEqual(await f.chat.files(context), []);
	} finally {
		await f.close();
	}
});

class DeleteFailureBackend implements FileBackend {
	readonly inner = new MemoryFileBackend();
	readonly failures = new Set<string>();
	transact<T>(chat: number, mode: "readonly" | "readwrite", fn: (tx: FileTx) => Promise<T>): Promise<T> {
		return this.inner.transact(chat, mode, (tx) => fn({
			...tx,
			delete: (path) => {
				if (this.failures.has(path)) throw new Error("injected delete failure");
				tx.delete(path);
			},
		}));
	}
	clear(chat: number) { return this.inner.clear(chat); }
}

test("post-commit cleanup failure preserves new files and retries only the removed paths", async () => {
	const files = new DeleteFailureBackend();
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("unused"),
	], { files });
	try {
		await f.chat.send({ text: "Start", requestId: "start" }, context);
		await f.started.promise;
		const id = await f.chat.send({ text: "Original", requestId: "queued", whenBusy: "followUp", attachments: [
			{ id: "old", name: "old.txt", mimeType: "text/plain", data: utf8.encode("old") },
		] }, context);
		await until(() => attachmentRefs(queued(f.chat)[0]?.content ?? "")[0], "the old attachment");
		const oldPath = attachmentRefs(queued(f.chat)[0]!.content)[0]!.path;
		files.failures.add(oldPath);
		assert.equal(await f.chat.updateQueued({
			id, requestId: "replacement-edit", removeAttachments: [oldPath],
			attachments: [{ id: "new", name: "new.txt", mimeType: "text/plain", data: utf8.encode("new") }],
		}, context), "updated");
		const paths = (await f.chat.files(context)).map((file) => file.path);
		assert.ok(paths.some((path) => path.endsWith("new.txt")), "the committed attachment is never rolled back by cleanup");
		files.failures.delete(oldPath);
		await resumeAttachmentDeletes(f.engine.harness, files, context, (error) => { throw error; });
		const remaining = await f.chat.files(context);
		assert.ok(!remaining.some((file) => file.path === oldPath.slice("/workspace/".length)));
		assert.ok(remaining.some((file) => file.path.endsWith("new.txt")));
	} finally {
		await f.close();
	}
});

test("a text-only model rejects an image before admission and leaves no file", async () => {
	const f = await fixture([fauxAssistantMessage("unused")], { modelInput: ["text"] });
	try {
		await assert.rejects(f.chat.send({ text: "Look", requestId: "no-vision", attachments: [
			{ id: "pixel", name: "pixel.png", mimeType: "image/png", data: PNG },
		] }, context), /cannot process images/);
		assert.deepEqual(await f.chat.files(context), []);
	} finally {
		await f.close();
	}
});

test("edits and model changes re-check every queued image, not only newly added files", async () => {
	const f = await fixture([
		fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("unused"),
	]);
	try {
		await f.chat.send({ text: "Start", requestId: "start" }, context);
		await f.started.promise;
		const id = await f.chat.send({ text: "Image", requestId: "image", whenBusy: "followUp", attachments: [
			{ id: "pixel", name: "pixel.png", mimeType: "image/png", data: PNG },
		] }, context);
		await until(() => queued(f.chat).length === 1 || undefined, "the queued image");
		const model = f.faux.getModel() as unknown as { provider: string; id: string; input: ("text" | "image")[] };
		model.input = ["text"];
		await assert.rejects(f.chat.updateQueued({ id, text: "Still an image" }, context), /cannot process images/);
		await assert.rejects(f.chat.configure({ provider: model.provider, modelId: model.id }, context), /cannot process images/);
	} finally {
		await f.close();
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
		const followUp = await f.chat.send({ text: "Follow-up", requestId: "follow", whenBusy: "followUp", attachments: [
			{ id: "abort-image", name: "abort.png", mimeType: "image/png", data: PNG },
		] }, context);
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
		assert.deepEqual(await f.chat.files(context), [], "withdrawing the queue also removes its unreferenced attachments");
	} finally {
		await f.close();
	}
});
