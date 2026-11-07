// The Engine's document is evicted in the middle of a model request (an offscreen document closed, a Firefox event
// page unloaded). A new Engine opens the same storage; Durable sends the request again; the panel, whose link dropped,
// connects to the new Engine and its chat reference comes back by itself, with the answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Browser } from "../src/contracts/browser.ts";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal } from "../src/contracts/hosts.ts";
import { type Engine, startEngine } from "../src/engine/engine.ts";
import { MemoryFileBackend } from "../src/engine/files.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet } from "../src/lib/chord.ts";
import { portLink } from "../src/link/port-link.ts";
import { fakePortPair } from "./fake-port.ts";

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

test("a run cut off by the Engine's eviction finishes on the next Engine, and the panel sees it", async () => {
	const onError = () => {};
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError });
	await broker.load(
		[
			{
				name: "broker",
				facet: defineFacet<Principal>((host) => {
					host.serve(Browser, () => ({
						variant: "engine",
						members: {
							listTabs: async () => [],
							activeTab: async () => null,
							openTab: async () => {
								throw new Error("unused");
							},
							attach: async () => null,
							hasAccess: async () => false,
							armWake: async () => null,
						},
					}));
				}),
			},
		],
		context,
	);

	// The first request hangs (the provider is slow); the Engine is evicted while it waits.
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
	// IndexedDB outlives the document that had it open: the next Engine opens the same data. Here, a memory storage
	// whose `close` keeps it.
	const memory = new MemoryStorage();
	const storage = new Proxy(memory, {
		get(target, key) {
			if (key === "close") return async () => {};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});

	const files = new MemoryFileBackend();
	const open = () =>
		startEngine(
			{
				storage,
				models,
				credentials: new InMemoryCredentialStore(),
				files,
				broker: async () => {
					const [engineEnd, brokerEnd] = fakePortPair();
					broker.accept(portLink(brokerEnd), { principal: { kind: "engine" } }, context);
					return portLink(engineEnd);
				},
				tab: async () => {
					throw new Error("no tabs here");
				},
				onError,
			},
			context,
		);
	const attachPanel = (engine: Engine) => {
		const [panelEnd, engineEnd] = fakePortPair("oshawatt:panel");
		engine.acceptPanel(portLink(engineEnd), "panel-1");
		return portLink(panelEnd);
	};

	let engine = await open();
	const panel = createHost<Principal>({ onError });
	const first = attachPanel(engine);
	panel.connect(first, { principal: { kind: "engine" } }, context);
	await panel.load([], context);

	const workspace = await panel.get(Workspace, {}, context);
	const model = faux.getModel();
	await workspace.setDefaultModel({ provider: model.provider, modelId: model.id }, context);
	const id = await workspace.createChat({}, context);
	const chat = await panel.get(Chat, { id }, context);
	await chat.send({ text: "Hello", requestId: "r1" }, context);
	await until(() => (firstRequestStarted ? true : undefined), "the first model request");

	// Eviction: the document goes away with its Engine and its ports.
	await engine.close();
	await until(() => ((first as { closed?: boolean }).closed ? true : undefined), "the panel's link to drop");

	// The browser brings the Engine back (an alarm, the panel reopening); the panel connects again.
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
