import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { AgentDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { ProvidersDoc, WorkspaceDoc } from "../src/engine/docs.ts";
import type { ProviderProfile } from "../src/contracts/chat.ts";
import { DEFAULT_INSTRUCTIONS } from "../src/engine/instructions.ts";
import { ChatSession } from "../src/panel/session.ts";
import { until } from "./support/wait.ts";
import { connectPanel, context, openEngine, persistentStorage, serveBrowser } from "./support/world.ts";

async function fixture(fetcher?: typeof fetch, modelsStore = new InMemoryModelsStore()) {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials, modelsStore });
	const faux = fauxProvider({ models: [{ id: "faux-a", reasoning: true }, { id: "faux-b" }] });
	models.setProvider(faux.provider);
	const broker = await serveBrowser();
	const storage = new MemoryStorage();
	const engine = await openEngine(broker, { storage, models, credentials, modelsStore, fetch: fetcher });
	const panel = await connectPanel(engine);
	const { workspace } = panel;
	await until(() => workspace.providers.value.length > 0, "the provider list");
	return {
		credentials, modelsStore, models, faux, engine, storage, workspace, host: panel.host,
		chat: (id: number) => panel.chat(id),
		close: async () => {
			await panel.close();
			await engine.close();
			await broker.close(context);
		},
	};
}

const profile: ProviderProfile = {
	id: "custom-local", name: "Local", baseUrl: "https://models.test/v1", api: "openai-responses",
	models: [{ id: "manual", name: "Manual", contextWindow: 32_000, maxTokens: 4_096, vision: true, thinkingLevels: ["off", "high"] }],
};
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

test("custom providers probe candidates selectively, keep only chosen models and protect keys", async () => {
	let fail = false;
	let probes = 0;
	const f = await fixture(async (input, init) => {
		probes++;
		assert.equal(input, "https://models.test/v1/models");
		assert.equal(init?.credentials, "omit");
		assert.equal(init?.redirect, "error");
		assert.equal((init?.headers as Record<string, string>).authorization, "Bearer secret-key");
		if (fail) return new Response("secret-key must not escape", { status: 500 });
		return Response.json({ data: [
			{ id: "remote", name: "Remote", context_length: 64_000, max_output_tokens: 8_192 },
			{ id: "vision", display_name: "Vision", input: ["text", "image"], reasoning: true },
		] });
	});
	try {
		// Probing before saving returns candidates without registering the provider or populating any catalog.
		const probed = await f.workspace.probeModels({ baseUrl: profile.baseUrl, api: profile.api, key: " secret-key " }, context);
		assert.equal(probes, 1);
		assert.deepEqual(probed.models.map((model) => model.id), ["remote", "vision"]);
		assert.equal(probed.models[1]?.vision, true);
		assert.deepEqual(probed.models[1]?.thinkingLevels, ["off", "minimal", "low", "medium", "high"]);
		assert.equal(f.workspace.providers.value.some((provider) => provider.id === profile.id), false);
		assert.equal(await f.modelsStore.read(profile.id), undefined);

		// Saving the provider with only the selected model ("manual" + "vision") never auto-adds "remote".
		const chosenVision = probed.models.find((model) => model.id === "vision")!;
		await f.workspace.saveProvider({ profile: { ...profile, models: [...profile.models, chosenVision] }, key: " secret-key " }, context);
		const custom = await until(() => f.workspace.providers.value.find((provider) => provider.id === profile.id));
		assert.equal(custom.kind, "custom");
		assert.equal(custom.configured, true);
		assert.deepEqual(custom.models.map((model) => model.id), ["manual", "vision"]);
		assert.equal(probes, 1, "saving does not trigger an automatic /models fetch");
		assert.deepEqual(await f.credentials.read(profile.id), { type: "api_key", key: "secret-key" });
		assert.equal(JSON.stringify(f.workspace.providers.value).includes("secret-key"), false);
		assert.equal(await f.modelsStore.read(profile.id), undefined);

		// Probing an existing provider without re-entering the key reuses the stored credential and omits secrets from errors.
		const reprobed = await f.workspace.probeModels({ provider: profile.id, baseUrl: profile.baseUrl, api: profile.api }, context);
		assert.equal(probes, 2);
		assert.deepEqual(reprobed.models.map((model) => model.id), ["remote", "vision"]);

		fail = true;
		await assert.rejects(f.workspace.probeModels({ provider: profile.id, baseUrl: profile.baseUrl, api: profile.api }, context), (error) => {
			assert.match(String(error), /HTTP 500/);
			assert.equal(String(error).includes("secret-key"), false);
			return true;
		});

		fail = false;
		await f.workspace.saveProvider({ profile: { ...profile, name: "Edited", models: [...profile.models, chosenVision] } }, context);
		const edited = f.workspace.providers.value.find((provider) => provider.id === profile.id);
		assert.equal(edited?.name, "Edited");
		assert.deepEqual(edited?.models.map((model) => model.id), ["manual", "vision"]);
		assert.equal(probes, 3, "editing without a key preserves auth and makes no network request");

		await f.workspace.setDefaultConfiguration({ model: { provider: profile.id, modelId: "manual" }, thinkingLevel: "high" }, context);
		const id = await f.workspace.createChat({}, context);
		assert.deepEqual(await f.engine.harness.snapshot(AgentDoc, id as never, context), {
			model: { provider: profile.id, modelId: "manual" }, thinkingLevel: "high", instructions: DEFAULT_INSTRUCTIONS,
		});
		await assert.rejects(f.workspace.saveProvider({ profile: { ...profile, models: [chosenVision] } }, context), /still used/, "removing a model still in use is rejected");
		assert.deepEqual(f.workspace.providers.value.find((provider) => provider.id === profile.id)?.models.map((model) => model.id), ["manual", "vision"]);
		await assert.rejects(f.workspace.deleteProvider({ provider: profile.id }, context), /still used/);

		const chat = await f.chat(id);
		const imageSubmission = await chat.send({
			text: "visual metadata check", requestId: "custom-vision", attachments: [{
				id: "pixel", name: "pixel.png", mimeType: "image/png",
				data: PNG,
			}],
		}, context);
		assert.ok(imageSubmission > 0, "a custom visual model accepts the existing native image attachment pipeline");
		await chat.abort(context);
		await chat.configure({ model: { provider: "faux", modelId: "faux-b" }, thinkingLevel: "off" }, context);
		chat.release();
		await f.workspace.setDefaultConfiguration({ model: { provider: "faux", modelId: "faux-b" }, thinkingLevel: "off" }, context);
		await f.workspace.deleteProvider({ provider: profile.id }, context);
		assert.equal(f.workspace.providers.value.some((provider) => provider.id === profile.id), false);
		assert.equal(await f.credentials.read(profile.id), undefined);
	} finally {
		await f.close();
	}
});

test("thinking levels and models are durable per conversation and reach the next real model request", async () => {
	const levels: string[] = [];
	const requestModels: string[] = [];
	const f = await fixture();
	f.faux.setResponses(Array.from({ length: 3 }, (_, index) => (_ctx: unknown, options: { reasoning?: string } | undefined, _state: unknown, model: { id: string }) => {
		levels.push(options?.reasoning ?? "off");
		requestModels.push(model.id);
		return fauxAssistantMessage(`answer ${index}`);
	}));
	try {
		await f.workspace.setDefaultConfiguration({ model: { provider: "faux", modelId: "faux-a" }, thinkingLevel: "high" }, context);
		const firstId = await f.workspace.createChat({}, context);
		const first = await f.chat(firstId);
		await first.send({ text: "one", requestId: "one" }, context);
		await until(() => levels.length === 1 ? true : undefined);
		await first.configure({ model: { provider: "faux", modelId: "faux-a" }, thinkingLevel: "low" }, context);
		await first.send({ text: "two", requestId: "two" }, context);
		await until(() => levels.length === 2 ? true : undefined);
		await f.workspace.setDefaultConfiguration({ model: { provider: "faux", modelId: "faux-b" }, thinkingLevel: "off" }, context);
		const secondId = await f.workspace.createChat({}, context);
		assert.deepEqual((await f.engine.harness.snapshot(AgentDoc, firstId as never, context))?.model, { provider: "faux", modelId: "faux-a" });
		assert.deepEqual(await f.engine.harness.snapshot(AgentDoc, secondId as never, context), {
			model: { provider: "faux", modelId: "faux-b" }, thinkingLevel: "off", instructions: DEFAULT_INSTRUCTIONS,
		});
		const second = await f.chat(secondId);
		await second.send({ text: "three", requestId: "three" }, context);
		await until(() => levels.length === 3 ? true : undefined);
		assert.deepEqual(levels, ["high", "low", "off"]);
		assert.deepEqual(requestModels, ["faux-a", "faux-a", "faux-b"]);
		await assert.rejects(second.configure({ model: { provider: "faux", modelId: "faux-b" }, thinkingLevel: "high" }, context), /does not support/);
		first.release();
		second.release();
	} finally {
		await f.close();
	}
});

test("chat configuration updates defaults and rejects image-incompatible changes atomically", async () => {
	const f = await fixture();
	try {
		const vision = f.faux.getModel("faux-a")!;
		const text = f.faux.getModel("faux-b")!;
		(vision as unknown as { input: ("text" | "image")[] }).input = ["text", "image"];
		(text as unknown as { input: ("text" | "image")[] }).input = ["text"];
		const visionRef = { provider: vision.provider, modelId: vision.id };
		const textRef = { provider: text.provider, modelId: text.id };
		await f.workspace.setDefaultConfiguration({ model: visionRef, thinkingLevel: "high" }, context);
		const id = await f.workspace.createChat({}, context);
		const chat = await f.chat(id);
		f.faux.setResponses([async (_request, options) => {
			await new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options?.signal?.reason ?? new Error("aborted"))));
			return fauxAssistantMessage("unused");
		}]);
		await chat.send({ text: "Start", requestId: "configure-start" }, context);
		await until(() => f.faux.state.callCount === 1 || undefined, "the hanging run");
		await chat.send({ text: "Image", requestId: "configure-image", whenBusy: "followUp", attachments: [
			{ id: "pixel", name: "pixel.png", mimeType: "image/png", data: PNG },
		] }, context);

		await chat.configure({ model: visionRef, thinkingLevel: "low" }, context);
		let workspace = await f.engine.harness.snapshot(WorkspaceDoc, context);
		let agent = await f.engine.harness.snapshot(AgentDoc, id as never, context);
		assert.deepEqual(workspace?.defaultModel, visionRef);
		assert.equal(workspace?.defaultThinkingLevel, "low");
		assert.deepEqual(agent?.model, visionRef);
		assert.equal(agent?.thinkingLevel, "low");

		await assert.rejects(chat.configure({ model: textRef, thinkingLevel: "off" }, context), /cannot process images/);
		workspace = await f.engine.harness.snapshot(WorkspaceDoc, context);
		agent = await f.engine.harness.snapshot(AgentDoc, id as never, context);
		assert.deepEqual(workspace?.defaultModel, visionRef, "a rejected chat change leaves the default model untouched");
		assert.equal(workspace?.defaultThinkingLevel, "low", "a rejected chat change leaves the default thinking level untouched");
		assert.deepEqual(agent?.model, visionRef);
		assert.equal(agent?.thinkingLevel, "low");
		await chat.abort(context);
	} finally {
		await f.close();
	}
});

test("configuring a chat while its visible reference is loading still configures the chat", async () => {
	const f = await fixture();
	try {
		const initial = f.faux.getModel("faux-a")!;
		const next = f.faux.getModel("faux-b")!;
		await f.workspace.setDefaultConfiguration({ model: { provider: initial.provider, modelId: initial.id }, thinkingLevel: "high" }, context);
		const id = await f.workspace.createChat({}, context);
		const session = new ChatSession(f.host, () => {});
		session.attachWorkspace(f.workspace);
		const opening = session.open(id, (commit) => {
			commit();
			return Promise.resolve();
		});
		assert.equal(session.id, id);
		assert.equal(session.chat, undefined, "the session is still loading its visible reference");
		await session.configure({ model: { provider: next.provider, modelId: next.id }, thinkingLevel: "off" });
		await opening;
		const agent = await f.engine.harness.snapshot(AgentDoc, id as never, context);
		assert.deepEqual(agent?.model, { provider: next.provider, modelId: next.id });
		assert.equal(agent?.thinkingLevel, "off");
		await session.open(undefined, (commit) => {
			commit();
			return Promise.resolve();
		});
	} finally {
		await f.close();
	}
});

test("provider deletion serializes with default and chat configuration without leaving dangling references", async () => {
	const store = new InMemoryModelsStore();
	const remove = store.delete.bind(store);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let delayed = false;
	store.delete = async (id, options) => {
		if (delayed) {
			entered.resolve();
			await release.promise;
		}
		return remove(id, options);
	};
	const f = await fixture(undefined, store);
	let chat: Awaited<ReturnType<typeof f.chat>> | undefined;
	try {
		await f.workspace.saveProvider({ profile }, context);
		const id = await f.workspace.createChat({}, context);
		chat = await f.chat(id);
		delayed = true;
		const deleting = f.workspace.deleteProvider({ provider: profile.id }, context);
		await entered.promise;
		const choosingDefault = assert.rejects(f.workspace.setDefaultConfiguration({
			model: { provider: profile.id, modelId: "manual" }, thinkingLevel: "high",
		}, context), /unavailable/);
		const choosingChat = assert.rejects(chat.configure({
			model: { provider: profile.id, modelId: "manual" }, thinkingLevel: "high",
		}, context), /unavailable/);
		release.resolve();
		await deleting;
		await choosingDefault;
		await choosingChat;
		assert.equal(f.workspace.defaultModel.value, null);
		assert.equal((await f.engine.harness.snapshot(AgentDoc, id as never, context))?.model, undefined);
		assert.equal(f.workspace.providers.value.some((provider) => provider.id === profile.id), false);
	} finally {
		release.resolve();
		chat?.release();
		await f.close();
	}
});

test("custom provider profiles and credentials restore before a new Engine resumes and drop legacy cached catalogs", async () => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify(profile.id, async () => ({ type: "api_key", key: "secret-key" }));
	const modelsStore = new InMemoryModelsStore();
	await modelsStore.write(profile.id, { models: [{
		id: "legacy-remote", name: "Legacy", api: profile.api, provider: profile.id, baseUrl: profile.baseUrl,
		input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false,
		contextWindow: 64_000, maxTokens: 8_192,
	}] });
	const storage = persistentStorage();
	const broker = await serveBrowser();
	const boot = (models: ReturnType<typeof createModels>) => openEngine(broker, { storage, models, credentials, modelsStore });
	const firstModels = createModels({ credentials, modelsStore });
	const first = await boot(firstModels);
	await first.harness.commit(async (tx) => {
		(await tx.doc(ProvidersDoc)).custom.push(profile);
	}, context);
	await first.close();
	const secondModels = createModels({ credentials, modelsStore });
	const second = await boot(secondModels);
	try {
		assert.equal(secondModels.getProvider(profile.id)?.name, profile.name);
		assert.deepEqual(secondModels.getModels(profile.id).map((model) => model.id), ["manual"]);
		assert.equal(await modelsStore.read(profile.id), undefined);
		assert.equal((await secondModels.checkAuth(profile.id))?.type, "api_key");
	} finally {
		await second.close();
		await broker.close(context);
	}
});
