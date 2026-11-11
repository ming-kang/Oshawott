import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Workspace } from "../src/contracts/chat.ts";
import type { Principal } from "../src/contracts/hosts.ts";
import { createHost, memoryLinkPair } from "../src/lib/chord.ts";
import { until } from "./support/wait.ts";
import { context, openEngine, serveBrowser } from "./support/world.ts";

test("provider auth checks run concurrently and key changes refresh the shared summary schema", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	const ids = ["ready", "missing", "broken"];
	for (const provider of ids) models.setProvider(fauxProvider({ provider, models: [{ id: "one", name: "One" }] }).provider);
	const allStarted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const started: string[] = [];
	models.checkAuth = async (id) => {
		started.push(id);
		if (started.length === ids.length) allStarted.resolve();
		await release.promise;
		if (id === "broken") throw new Error("auth failed");
		return id === "ready" || await credentials.read(id) ? { type: "api_key" } : undefined;
	};
	const broker = await serveBrowser();
	const engine = await openEngine(broker, { models, credentials });
	// Not `connectPanel`: the Workspace must be requested before the auth checks it waits for can finish.
	const panel = createHost<Principal>({ onError: () => {} });
	const [panelEnd, engineEnd] = memoryLinkPair();
	engine.acceptPanel(engineEnd, "provider-test");
	panel.connect(panelEnd, { principal: { kind: "engine" } }, context);
	await panel.load([], context);
	const holding = panel.get(Workspace, {}, context);
	const timer = setTimeout(() => allStarted.reject(new Error("auth checks did not start concurrently")), 2000);
	try {
		await allStarted.promise;
		assert.deepEqual(started, ids);
		release.resolve();
		const workspace = await holding;
		assert.equal(workspace.variant, "owner");
		await until(() => workspace.providers.value.length === ids.length);
		assert.deepEqual(workspace.providers.value.map(({ id, configured }) => ({ id, configured })), [
			{ id: "ready", configured: true }, { id: "missing", configured: false }, { id: "broken", configured: false },
		]);
		assert.deepEqual(workspace.providers.value[0]?.models, [{
			id: "one", name: "One", vision: true, contextWindow: 128_000, maxTokens: 16_384,
			thinkingLevels: ["off"], manual: false,
		}]);
		assert.equal(workspace.defaultModel.value, null);
		assert.equal(workspace.busyMode.value, "steer");
		await workspace.setBusyMode("followUp", context);
		await until(() => workspace.busyMode.value === "followUp");
		await workspace.setBusyMode("steer", context);
		await until(() => workspace.busyMode.value === "steer");
		await workspace.setApiKey({ provider: "missing", key: " test-key " }, context);
		await until(() => workspace.providers.value.find((provider) => provider.id === "missing")?.configured === true);
		assert.deepEqual(await credentials.read("missing"), { type: "api_key", key: "test-key" });
		await workspace.clearApiKey({ provider: "missing" }, context);
		await until(() => workspace.providers.value.find((provider) => provider.id === "missing")?.configured === false);
		workspace.release();
	} finally {
		clearTimeout(timer);
		release.resolve();
		await holding.catch(() => {});
		await panel.close(context);
		await engine.close();
		await broker.close(context);
	}
});
