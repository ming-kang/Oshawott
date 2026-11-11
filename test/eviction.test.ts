import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import type { Principal } from "../src/contracts/hosts.ts";
import type { Engine } from "../src/engine/engine.ts";
import { MemoryFileBackend } from "../src/engine/files.ts";
import { createHost } from "../src/lib/chord.ts";
import { until } from "./support/wait.ts";
import { context, ignore, openEngine, persistentStorage, portPair, serveBrowser } from "./support/world.ts";

test("a run cut off by the Engine's eviction finishes on the next Engine, and the panel sees it", async () => {
	const broker = await serveBrowser();

	let firstRequestStarted = false;
	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		// Waits until the closing document aborts it, as the browser does to a page's fetches.
		async (_request, options) => {
			firstRequestStarted = true;
			await new Promise((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			return fauxAssistantMessage("never");
		},
		fauxAssistantMessage("Answered after the restart."),
	]);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const storage = persistentStorage();
	const files = new MemoryFileBackend();
	const open = () => openEngine(broker, { storage, models, files, pair: portPair });
	const attachPanel = (engine: Engine) => {
		const [panelEnd, engineEnd] = portPair();
		engine.acceptPanel(engineEnd, "panel-1");
		return panelEnd;
	};

	let engine = await open();
	const panel = createHost<Principal>({ onError: ignore });
	const first = attachPanel(engine);
	panel.connect(first, { principal: { kind: "engine" } }, context);
	await panel.load([], context);

	const workspace = await panel.get(Workspace, {}, context);
	const model = faux.getModel();
	await workspace.setDefaultConfiguration({ model: { provider: model.provider, modelId: model.id } }, context);
	const id = await workspace.createChat({}, context);
	const chat = await panel.get(Chat, { id }, context);
	await chat.send({ text: "Hello", requestId: "r1" }, context);
	await until(() => (firstRequestStarted ? true : undefined), "the first model request");

	await engine.close();
	await until(() => ((first as { closed?: boolean }).closed ? true : undefined), "the panel's link to drop");

	engine = await open();
	panel.connect(attachPanel(engine), { principal: { kind: "engine" } }, context);

	const answer = await until(() => {
		const last = chat.view.value?.entries.at(-1) as
			| { kind?: string; model?: { content?: { type: string; text?: string }[]; stopReason?: string }[] }
			| undefined;
		const message = last?.model?.[0];
		if (last?.kind !== "pi.assistant" || message?.stopReason !== "stop") return undefined;
		return message.content?.find((block) => block.type === "text")?.text;
	}, "the answer after the restart");
	assert.equal(answer, "Answered after the restart.");
	assert.equal(faux.state.callCount, 2, "the cut-off request was sent again, once");

	chat.release();
	workspace.release();
	await panel.close(context);
	await engine.close();
	await broker.close(context);
});
