import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { createModels, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ProviderSummary } from "../src/contracts/chat.ts";
import { clampThinking, shownModel, supportedThinkingLevels } from "../src/panel/models.ts";
import { deferred, until } from "./support/wait.ts";

const model = (id: string, name: string, vision: boolean): ProviderSummary["models"][number] => ({
	id, name, vision, contextWindow: 128_000, maxTokens: 16_384, thinkingLevels: ["off"],
});
const provider = (id: string, name: string, configured: boolean, models: ProviderSummary["models"]): ProviderSummary => ({
	id, name, kind: "builtin", baseUrl: "https://example.test/v1", api: null, configured, auth: configured ? "api_key" : null, apiKey: true, oauth: null, models, refreshing: false, discoveryError: null,
});
const providers: ProviderSummary[] = [
	provider("offline", "Offline", false, [model("unavailable", "Unavailable", false)]),
	provider("empty", "Empty", true, []),
	provider("first", "First", true, [model("one", "Model One", true), model("two", "Model Two", false)]),
	provider("second", "Second", true, [model("three", "Model Three", true)]),
];

test("model fallback skips disconnected and empty providers, preserving a connected choice", () => {
	assert.deepEqual(shownModel(providers, undefined), { provider: "first", modelId: "one" });
	assert.deepEqual(shownModel(providers, { provider: "offline", modelId: "unavailable" }), { provider: "first", modelId: "one" });
	const choice = { provider: "second", modelId: "three" };
	assert.equal(shownModel(providers, choice), choice);
});

test("no fallback keeps a configured model reference for error feedback, or leaves an empty choice empty", () => {
	const choice = { provider: "offline", modelId: "unavailable" };
	assert.equal(shownModel([], choice), choice);
	assert.equal(shownModel([providers[1]!], undefined), undefined);
	assert.equal(shownModel([], undefined), undefined);
});

test("thinking choices come from the selected model and clamp to a supported level", () => {
	const reasoning = { ...model("reasoning", "Reasoning", false), thinkingLevels: ["off", "low", "high"] as ("off" | "low" | "high")[] };
	const list = [provider("reasoning", "Reasoning", true, [reasoning])];
	const ref = { provider: "reasoning", modelId: "reasoning" };
	assert.deepEqual(supportedThinkingLevels(list, ref), ["off", "low", "high"]);
	assert.equal(clampThinking(supportedThinkingLevels(list, ref), "high"), "high");
	assert.equal(clampThinking(supportedThinkingLevels(list, ref), "medium"), "high");
	assert.equal(clampThinking(supportedThinkingLevels(list, ref), "minimal"), "low");
	assert.equal(clampThinking(["off"], "max"), "off");
});

test("panel send requests missing site access synchronously without waiting, but never requests granted access", async () => {
	const listeners = new Set<() => void>();
	const event = { addListener: (listener: () => void) => listeners.add(listener) };
	const starting = deferred();
	const connecting = deferred();
	let granted = false;
	let requests = 0;
	let result = Promise.withResolvers<boolean>();
	const scope = globalThis as typeof globalThis & { browser?: unknown };
	scope.browser = {
		permissions: {
			contains: async () => granted,
			request: (permissions: { origins: string[] }) => {
				assert.deepEqual(permissions, { origins: ["<all_urls>"] });
				requests++;
				return result.promise;
			},
			onAdded: event, onRemoved: event,
		},
		tabs: { query: async () => [], onActivated: event, onUpdated: event, onRemoved: event },
		runtime: { sendMessage: () => { starting.resolve(); return connecting.promise; } },
	};
	const events = new EventTarget();
	Object.assign(globalThis, {
		addEventListener: events.addEventListener.bind(events),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			queueMicrotask(() => callback(performance.now()));
			return 0;
		},
	});
	const jsx = registerHooks({ load(url, context, next) {
		if (!url.endsWith(".tsx")) return next(url, context);
		return { format: "module", shortCircuit: true, source: transformSync(readFileSync(new URL(url), "utf8"), {
			loader: "tsx", jsx: "automatic", jsxImportSource: "vue",
		}).code };
	} });
	const { PanelController } = await import("../src/panel/controller.ts");
	jsx.deregister();
	const { connectPanel, context, openEngine, serveBrowser, useModel } = await import("./support/world.ts");
	const broker = await serveBrowser();
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	faux.setResponses(["First", "Second", "Third"].map(text => fauxAssistantMessage(text)));
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const engine = await openEngine(broker, { models });
	const panel = await connectPanel(engine);
	try {
		await useModel(panel.workspace, faux);
		await panel.workspace.setPreference({ key: "autoTitle", enabled: false }, context);
		const controller = new PanelController(panel.host);
		controller.session.attachWorkspace(panel.workspace);
		void controller.start();
		await starting.promise;
		for (const mode of ["pending", "granted", "rejected"]) {
			granted = mode === "granted";
			for (const listener of listeners) listener();
			await Promise.resolve();
			requests = 0;
			result = Promise.withResolvers<boolean>();
			const configuring = deferred();
			Object.defineProperty(controller.session, "configuring", { configurable: true, value: configuring.promise });
			controller.composer.text = `Send with ${mode} access`;
			const sending = controller.send();
			assert.equal(requests, granted ? 0 : 1, "permission request must precede the configuration await");
			if (mode === "rejected") result.reject(new Error("Permission request rejected"));
			configuring.resolve();
			await until(() => controller.composer.text === "" && !controller.store.sending.value, "send without waiting for permission");
			await sending;
			assert.notEqual(controller.session.id, undefined);
			result.resolve(false);
			Reflect.deleteProperty(controller.session, "configuring");
		}
	} finally {
		await panel.close();
		await engine.close();
		await broker.close(context);
	}
});
