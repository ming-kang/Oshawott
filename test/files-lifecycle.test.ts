import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, MemoryStorage, type Extension } from "@earendil-works/pi-durable";
import { type ExecutionEnv, getOrThrow } from "@earendil-works/pi-durable/env";
import { obj } from "@earendil-works/pi-schema";
import { Browser } from "../src/contracts/browser.ts";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal } from "../src/contracts/hosts.ts";
import { WorkspaceDoc } from "../src/engine/docs.ts";
import { startEngine, type Engine } from "../src/engine/engine.ts";
import { ChatFiles, type FileBackend, MemoryFileBackend } from "../src/engine/files.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet, type Host, memoryLinkPair, type Reference } from "../src/lib/chord.ts";

const context = BACKGROUND_CONTEXT;
type WorkspaceRef = Extract<Reference<typeof Workspace>, { variant: "owner" }>;
type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;
type Panel = { host: Host<Principal>; workspace: WorkspaceRef; chat(id: number): Promise<ChatRef> };
type World = { engine(): Engine; panel(): Promise<Panel>; restart(): Promise<void>; faux: ReturnType<typeof fauxProvider> };

async function withWorld(files: FileBackend, use: (world: World) => Promise<void>, extensions: readonly Extension[] = []) {
	const raw = new MemoryStorage();
	const storage = new Proxy(raw, { get(target, key) {
		if (key === "close") return async () => {};
		const value = Reflect.get(target, key, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	models.setProvider(faux.provider);
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError: () => {} });
	await broker.load([{ name: "broker", facet: defineFacet<Principal>((host) => {
		host.serve(Browser, () => ({ variant: "engine", members: {
			listTabs: async () => [], activeTab: async () => null, openTab: async () => { throw new Error("unused"); },
			attach: async () => null, hasAccess: async () => false, armWake: async () => null,
		} }));
	}) }], context);
	const clients = new Set<Host<Principal>>();
	const open = () => startEngine({
		storage, models, credentials, files, extensions, onError: () => {},
		broker: async () => {
			const [engineEnd, brokerEnd] = memoryLinkPair();
			broker.accept(brokerEnd, { principal: { kind: "engine" } }, context);
			return engineEnd;
		},
		tab: async () => { throw new Error("unused"); },
	}, context);
	let engine = await open();
	const close = async () => {
		for (const client of clients) await client.close(context);
		clients.clear();
		await engine.close();
	};
	try {
		await use({
			engine: () => engine, faux,
			restart: async () => { await close(); engine = await open(); },
			panel: async () => {
				const client = createHost<Principal>({ onError: () => {} });
				clients.add(client);
				const [panelEnd, engineEnd] = memoryLinkPair();
				engine.acceptPanel(engineEnd, crypto.randomUUID());
				client.connect(panelEnd, { principal: { kind: "engine" } }, context);
				await client.load([], context);
				const workspace = await client.get(Workspace, {}, context);
				if (workspace.variant !== "owner") throw new Error("not a panel");
				const model = faux.getModel();
				await workspace.setDefaultModel({ provider: model.provider, modelId: model.id }, context);
				return { host: client, workspace, chat: async (id) => {
					const chat = await client.get(Chat, { id }, context);
					if (chat.variant !== "owner") throw new Error("no chat");
					return chat;
				} };
			},
		});
	} finally {
		await close();
		await broker.close(context);
		await raw.close(context);
	}
}

for (const when of ["before", "after"] as const) {
	test(`file deletion resumes after a failure ${when} clearing, leaving other chats intact`, async () => {
		class FailingBackend extends MemoryFileBackend {
			fail = true;
			override async clear(chat: number) {
				if (when === "after") await super.clear(chat);
				if (this.fail) { this.fail = false; throw new Error("simulated interruption"); }
				if (when === "before") await super.clear(chat);
			}
		}
		const files = new FailingBackend();
		await withWorld(files, async (world) => {
			const panel = await world.panel();
			const id = await panel.workspace.createChat({}, context);
			const other = await panel.workspace.createChat({}, context);
			getOrThrow(await new ChatFiles(files, id).writeFile("notes.txt", "removed", context));
			getOrThrow(await new ChatFiles(files, other).writeFile("notes.txt", "kept", context));
			await assert.rejects(panel.workspace.deleteChat({ id }, context), /simulated interruption/);
			const pending = await world.engine().harness.snapshot(WorkspaceDoc, context);
			assert.equal(pending!.chats.some((chat) => chat.id === id), false);
			assert.deepEqual(pending!.pendingFileDeletes, [id]);
			await world.restart();
			assert.deepEqual((await world.engine().harness.snapshot(WorkspaceDoc, context))!.pendingFileDeletes, []);
			assert.deepEqual(getOrThrow(await new ChatFiles(files, id).workspaceFiles(context)), []);
			assert.equal(getOrThrow(await new ChatFiles(files, other).readTextFile("notes.txt", context)), "kept");
		});
	});
}

test("deleted chats cannot submit or read files through old/new references or write through an old environment", async () => {
	const files = new MemoryFileBackend();
	let captured: ExecutionEnv | undefined;
	const capture = defineExtension({ name: "capture", tools: [defineTool({
		name: "capture_env", description: "test", parameters: obj({}),
		execute: async (_args, api) => { captured = api.env; return { output: [{ type: "text", text: "captured" }] }; },
	})] });
	await withWorld(files, async (world) => {
		world.faux.setResponses([fauxAssistantMessage(fauxToolCall("capture_env", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
		const panel = await world.panel();
		const id = await panel.workspace.createChat({}, context);
		const held = await panel.chat(id);
		await held.send({ text: "Capture.", requestId: "capture" }, context);
		const deadline = Date.now() + 5000;
		while (!captured) {
			if (Date.now() > deadline) throw new Error("no environment");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await panel.workspace.deleteChat({ id }, context);
		await assert.rejects(held.send({ text: "Recreate files.", requestId: "old" }, context), /No chat/);
		await assert.rejects(held.files(context), /No chat/);
		const next = await (await world.panel()).chat(id);
		await assert.rejects(next.send({ text: "Recreate files.", requestId: "new" }, context), /No chat/);
		await assert.rejects(next.readFile({ path: "notes.txt" }, context), /No chat/);
		const refused = await captured.writeFile("ghost.txt", "ghost", context);
		assert.equal(!refused.ok && refused.error.code, "permission_denied");
		assert.deepEqual(getOrThrow(await new ChatFiles(files, id).workspaceFiles(context)), []);
	}, [capture]);
});

test("deleting a running tool cancels it and rejects a late write through its captured environment", async () => {
	const files = new MemoryFileBackend();
	const started = Promise.withResolvers<void>();
	const attempted = Promise.withResolvers<{ ok: boolean; code?: string }>();
	const extension = defineExtension({ name: "wait", tools: [defineTool({
		name: "wait_for_abort", description: "test", parameters: obj({}), replay: "unsafe",
		execute: async (_args, api, ctx) => {
			const env = api.env!;
			started.resolve();
			await new Promise<void>((resolve) => {
				if (ctx.abortSignal?.aborted) resolve();
				else ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
			});
			const result = await env.writeFile("late.txt", "late", context);
			attempted.resolve({ ok: result.ok, ...(!result.ok ? { code: result.error.code } : {}) });
			return { output: [{ type: "text", text: "ended" }] };
		},
	})] });
	await withWorld(files, async (world) => {
		world.faux.setResponses([fauxAssistantMessage(fauxToolCall("wait_for_abort", {}), { stopReason: "toolUse" })]);
		const panel = await world.panel();
		const id = await panel.workspace.createChat({}, context);
		await (await panel.chat(id)).send({ text: "Wait.", requestId: "wait" }, context);
		await started.promise;
		await panel.workspace.deleteChat({ id }, context);
		assert.deepEqual(await attempted.promise, { ok: false, code: "permission_denied" });
		assert.deepEqual(getOrThrow(await new ChatFiles(files, id).workspaceFiles(context)), []);
	}, [extension]);
});

test("a send with an old lookup is rejected on the admission commit after deletion", async () => {
	const files = new MemoryFileBackend();
	await withWorld(files, async (world) => {
		const panel = await world.panel();
		const id = await panel.workspace.createChat({}, context);
		const held = await panel.chat(id);
		const harness = world.engine().harness;
		const original = harness.conversation;
		const lookedUp = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		let pause = true;
		harness.conversation = async (lookup, ctx) => {
			const found = await original.call(harness, lookup, ctx);
			if (pause && lookup === id) { pause = false; lookedUp.resolve(); await proceed.promise; }
			return found;
		};
		const sending = held.send({ text: "Race.", requestId: "old-lookup" }, context);
		try {
			await lookedUp.promise;
			await panel.workspace.deleteChat({ id }, context);
			proceed.resolve();
			await assert.rejects(sending, /No chat/);
		} finally {
			proceed.resolve();
			harness.conversation = original;
			await sending.catch(() => {});
		}
		assert.deepEqual(getOrThrow(await new ChatFiles(files, id).workspaceFiles(context)), []);
	});
});

test("another panel cannot admit input while file deletion is pending", async () => {
	class DelayedBackend extends MemoryFileBackend {
		started = Promise.withResolvers<void>();
		proceed = Promise.withResolvers<void>();
		override async clear(id: number) { this.started.resolve(); await this.proceed.promise; await super.clear(id); }
	}
	const files = new DelayedBackend();
	await withWorld(files, async (world) => {
		const first = await world.panel();
		const id = await first.workspace.createChat({}, context);
		const second = await world.panel();
		const held = await second.chat(id);
		const deleting = first.workspace.deleteChat({ id }, context);
		try {
			await files.started.promise;
			assert.deepEqual((await world.engine().harness.snapshot(WorkspaceDoc, context))!.pendingFileDeletes, [id]);
			await assert.rejects(held.send({ text: "Race.", requestId: "race" }, context), /No chat/);
			await assert.rejects(held.files(context), /No chat/);
		} finally {
			files.proceed.resolve();
			await deleting;
		}
		assert.deepEqual(getOrThrow(await new ChatFiles(files, id).workspaceFiles(context)), []);
	});
});
