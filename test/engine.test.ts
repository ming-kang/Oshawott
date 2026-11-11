import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Chat } from "../src/contracts/chat.ts";
import { Page } from "../src/contracts/page.ts";
import { until } from "./support/wait.ts";
import { connectPanel, context, fakeBrowser, linkTo, openEngine, portPair, serveBrowser, servePage, useModel } from "./support/world.ts";

test("a panel's prompt runs a page tool on its tab and the answer reaches the panel", async () => {
	const errors: unknown[] = [];
	const onError = (error: unknown) => errors.push(error);
	const wakes: { active: boolean; at?: number }[] = [];
	const tab = { tabId: 7, windowId: 1, url: "https://example.com/", title: "Example", active: true, access: true };
	const broker = await serveBrowser(fakeBrowser({
		getTab: async () => tab, listTabs: async () => [tab], activeTab: async () => tab, openTab: async () => tab,
		armWake: async (wake) => {
			wakes.push(wake);
			return null;
		},
	}), onError);

	const snapshots: number[] = [];
	const done = async () => ({ ok: true });
	const page = await servePage(7, {
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
		page_click: done, page_type: done, page_scroll: done, page_select: done, page_press: done, page_hover: done, page_wait: done,
		describe: async () => ({ role: "link", name: "More information" }),
	}, onError);

	const tabResolves: number[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("page_snapshot", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("The page is Example Domain."),
	]);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);

	const engine = await openEngine(broker, {
		models,
		pair: portPair,
		tab: async (tabId) => {
			tabResolves.push(tabId);
			return linkTo(page, portPair);
		},
		now: () => 1_700_000_000_000,
		onError,
	});
	const { host: panel, workspace } = await connectPanel(engine, { pair: portPair, onError });

	await useModel(workspace, faux);
	const model = faux.getModel();
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
