import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { until } from "./support/wait.ts";
import { connectPanel, context, openEngine, serveBrowser } from "./support/world.ts";

test("a stored API key configures its provider until removed, and a failing auth check reads as unconfigured", async () => {
	const credentials = new InMemoryCredentialStore();
	const models = createModels({ credentials });
	for (const provider of ["missing", "broken"]) models.setProvider(fauxProvider({ provider, models: [{ id: "one", name: "One" }] }).provider);
	models.checkAuth = async (id) => {
		if (id === "broken") throw new Error("auth failed");
		return await credentials.read(id) ? { type: "api_key" } : undefined;
	};
	const broker = await serveBrowser();
	const engine = await openEngine(broker, { models, credentials });
	const { workspace, close } = await connectPanel(engine);
	const configured = (id: string) => workspace.providers.value.find((provider) => provider.id === id)?.configured;
	try {
		await until(() => workspace.providers.value.length === 2);
		assert.equal(configured("missing"), false);
		assert.equal(configured("broken"), false);
		await workspace.setApiKey({ provider: "missing", key: " test-key " }, context);
		await until(() => configured("missing"), "the key to configure its provider");
		assert.deepEqual(await credentials.read("missing"), { type: "api_key", key: "test-key" });
		await workspace.removeCredential({ provider: "missing" }, context);
		await until(() => configured("missing") === false, "the removed key to unconfigure its provider");
		assert.equal(await credentials.read("missing"), undefined);
	} finally {
		await close();
		await engine.close();
		await broker.close(context);
	}
});
