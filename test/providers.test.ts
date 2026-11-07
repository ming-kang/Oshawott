// Provider state must reflect pi-ai's AuthCheck result, with independent auth checks started together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Browser } from "../src/contracts/browser.ts";
import { Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal } from "../src/contracts/hosts.ts";
import { startEngine } from "../src/engine/engine.ts";
import { MemoryFileBackend } from "../src/engine/files.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet, memoryLinkPair } from "../src/lib/chord.ts";

const context = BACKGROUND_CONTEXT;
async function until(read: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!read()) {
		if (Date.now() >= deadline) throw new Error("provider state did not refresh");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

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
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError: () => {} });
	await broker.load([{ name: "broker", facet: defineFacet<Principal>((host) => {
		host.serve(Browser, () => ({ variant: "engine", members: {
			listTabs: async () => [], activeTab: async () => null,
			openTab: async () => { throw new Error("unused"); }, attach: async () => null,
			hasAccess: async () => false, armWake: async () => null,
		} }));
	}) }], context);
	const engine = await startEngine({
		storage: new MemoryStorage(), models, credentials, files: new MemoryFileBackend(), onError: () => {},
		broker: async () => {
			const [engineEnd, brokerEnd] = memoryLinkPair();
			broker.accept(brokerEnd, { principal: { kind: "engine" } }, context);
			return engineEnd;
		},
		tab: async () => { throw new Error("unused"); },
	}, context);
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
		assert.deepEqual(workspace.providers.value[0]?.models, [{ id: "one", name: "One" }]);
		assert.equal(workspace.defaultModel.value, null);
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
