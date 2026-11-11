import { unusedTabActions } from "./fake-browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Browser } from "../src/contracts/browser.ts";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal, TabHost } from "../src/contracts/hosts.ts";
import { Page } from "../src/contracts/page.ts";
import { startEngine } from "../src/engine/engine.ts";
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

test("a panel's prompt runs a page tool on its tab and the answer reaches the panel", async () => {
	const errors: unknown[] = [];
	const onError = (error: unknown) => errors.push(error);
	const wakes: { active: boolean; at?: number }[] = [];
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError });
	await broker.load(
		[
			{
				name: "broker",
				facet: defineFacet<Principal>((host) => {
					host.serve(Browser, (_params, principal) => {
						assert.equal(principal.kind, "engine");
						const tab = { tabId: 7, windowId: 1, url: "https://example.com/", title: "Example", active: true, access: true };
						return {
							variant: "engine",
							members: {
								...unusedTabActions, getTab: async () => tab, listTabs: async () => [tab],
								activeTab: async () => tab,
								openTab: async () => tab,
								attach: async () => null,
								hasAccess: async () => false,
								armWake: async (wake) => {
									wakes.push(wake);
									return null;
								},
							},
						};
					});
				}),
			},
		],
		context,
	);

	const snapshots: number[] = [];
	const page = createHost<Principal>({ address: TabHost({ tabId: 7 }), principal: { kind: "tab", tabId: 7 }, onError });
	await page.load(
		[
			{
				name: "page",
				facet: defineFacet<Principal>((host) => {
					host.serve(Page, () => ({
						variant: "engine",
						members: {
							page_snapshot: async () => {
								snapshots.push(Date.now());
								return {
									url: "https://example.com/",
									title: "Example Domain",
									text: "This domain is for use in examples.",
									truncated: false,
									elements: [{ ref: "e1", role: "link", name: "More information" }],
								};
							},
							page_inspect: async () => ({ url: "https://example.com/", matched: 0, truncated: false, elements: [] }),
							page_click: async () => ({ ok: true }),
							page_type: async () => ({ ok: true }),
							page_scroll: async () => ({ ok: true }),
							page_select: async () => ({ ok: true }), page_press: async () => ({ ok: true }), page_hover: async () => ({ ok: true }),
							page_wait: async () => ({ ok: true }), describe: async () => ({ role: "link", name: "More information" }),
						},
					}));
				}),
			},
		],
		context,
	);

	const tabResolves: number[] = [];
	const linkTo = (target: typeof broker) => {
		const [engineEnd, otherEnd] = fakePortPair();
		target.accept(portLink(otherEnd), { principal: { kind: "engine" } }, context);
		return portLink(engineEnd);
	};

	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("page_snapshot", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("The page is Example Domain."),
	]);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);

	const engine = await startEngine(
		{
			storage: new MemoryStorage(),
			models,
			credentials: new InMemoryCredentialStore(),
			files: new MemoryFileBackend(),
			broker: async () => linkTo(broker),
			tab: async (tabId) => {
				tabResolves.push(tabId);
				return linkTo(page);
			},
			now: () => 1_700_000_000_000,
			onError,
		},
		context,
	);

	const [panelEnd, engineEnd] = fakePortPair("oshawott:panel");
	engine.acceptPanel(portLink(engineEnd), "panel-1");
	const panel = createHost<Principal>({ onError });
	panel.connect(portLink(panelEnd), { principal: { kind: "engine" } }, context);
	await panel.load([], context);

	const workspace = await panel.get(Workspace, {}, context);
	assert.equal(workspace.variant, "owner");
	const model = faux.getModel();
	await workspace.setDefaultConfiguration({ model: { provider: model.provider, modelId: model.id } }, context);
	const id = await workspace.createChat({ title: "First" }, context);
	await until(() => (workspace.chats.value.length === 1 ? true : undefined), "the chat in the workspace");
	assert.equal(workspace.chats.value[0]?.title, "First");
	assert.deepEqual(workspace.defaultModel.value, { provider: model.provider, modelId: model.id });

	const chat = await panel.get(Chat, { id }, context);
	await chat.send({ text: "What is this page?", requestId: "r1", tabId: 7 }, context);

	const answer = await until(() => {
		const entries = chat.view.value?.entries ?? [];
		const last = entries.at(-1) as { kind?: string; model?: { content?: { type: string; text?: string }[]; stopReason?: string }[] } | undefined;
		const message = last?.model?.[0];
		if (last?.kind !== "pi.assistant" || message?.stopReason !== "stop") return undefined;
		return message.content?.find((block) => block.type === "text")?.text;
	}, "the answer in the panel's view");

	assert.equal(answer, "The page is Example Domain.");
	assert.equal(snapshots.length, 1, "the page tool ran once, on the page host");
	assert.deepEqual(tabResolves, [7], "the Engine resolved the route to tab 7 once");
	const kinds = (chat.view.value?.entries ?? []).map((entry) => (entry as { kind: string }).kind);
	assert.ok(kinds.includes("pi.tool-result"), `a tool result in ${kinds.join(", ")}`);
	const snapshotMessage = chat.view.value?.entries.find((entry) => entry.kind === "pi.tool-result")?.model?.[0];
	assert.equal(snapshotMessage?.role, "toolResult");
	if (snapshotMessage?.role === "toolResult") {
		assert.deepEqual(snapshotMessage.details, { snapshot: { title: "Example Domain", elementCount: 1 } });
		assert.equal(snapshotMessage.content[0]?.type, "text");
		if (snapshotMessage.content[0]?.type === "text") {
			assert.deepEqual(JSON.parse(snapshotMessage.content[0].text), {
				url: "https://example.com/", title: "Example Domain", text: "This domain is for use in examples.",
				truncated: false, elements: [{ ref: "e1", role: "link", name: "More information" }],
			});
		}
	}
	assert.ok(wakes.some((wake) => wake.active), "the Broker was asked for a recovery wakeup while the run was active");

	faux.appendResponses([fauxAssistantMessage("Hello.")]);
	const second = await workspace.createChat({}, context);
	const secondChat = await panel.get(Chat, { id: second }, context);
	await secondChat.send({ text: "  Say hello\nto the   whole page, please  ", requestId: "r2" }, context);
	const title = await until(() => workspace.chats.value.find((c) => c.id === second)?.title || undefined, "the second chat's title");
	assert.equal(title, "Say hello");
	await until(() => (secondChat.view.value?.docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined || undefined, "the second run's end");
	await workspace.deleteChat({ id: second }, context);
	await until(() => (workspace.chats.value.length === 1 ? true : undefined), "the second chat removed");
	secondChat.release();

	await assert.rejects(panel.get(Page, { tabId: 7 }, context, { readyTimeout: 500 }), /forbidden|refus|not/i);

	chat.release();
	workspace.release();
	await panel.close(context);
	await engine.close();
	await page.close(context);
	await broker.close(context);
	assert.deepEqual(
		errors.filter((error) => !/closed|released|aborted/i.test(JSON.stringify(error) + String(error))),
		[],
	);
});
