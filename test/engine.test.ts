import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Chat } from "../src/contracts/chat.ts";
import { Page } from "../src/contracts/page.ts";
import { USER_ENTRY, userInput } from "../src/lib/attachments.ts";
import { until } from "./support/wait.ts";
import { type ChatRef, connectPanel, context, fakeBrowser, linkTo, openEngine, portPair, serveBrowser, servePage, useModel } from "./support/world.ts";

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
				textOffset: 0,
				totalChars: 37,
				elements: [{ ref: "e1", role: "link", name: "More information" }],
				elementsTruncated: false,
			};
		},
		page_inspect: async () => ({ url: "https://example.com/", matched: 0, truncated: false, elements: [] }),
		page_click: done, page_type: done, page_scroll: done, page_select: done, page_press: done, page_hover: done, page_wait: done,
		describe: async () => ({ role: "link", name: "More information" }),
		settled: async () => ({ url: "https://example.com/", title: "Example Domain", opened: [], appeared: [], appearedMore: false }),
		viewport: async () => ({ width: 1280, height: 800, dpr: 1 }),
		upload: async () => ({ ok: true }),
	}, onError);

	const tabResolves: number[] = [];
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	let tools: { name: string; parameters: unknown }[] = [];
	faux.setResponses([
		(request) => {
			tools = request.messages.flatMap((message) => (message.role === "system" ? message.toolsAdded ?? [] : []));
			return fauxAssistantMessage(fauxToolCall("page_snapshot", {}), { stopReason: "toolUse" });
		},
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
	// Strict providers (Moonshot) refuse a tool whose parameter schema has a node without `type`.
	assert.ok(tools.some((tool) => tool.name === "fetch"), "the files tools reach the model");
	assert.deepEqual(tools.flatMap((tool) => untypedNodes(tool.parameters, tool.name)), []);
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
			assert.equal(snapshotMessage.content[0].text, [
				"Title: Example Domain",
				"URL: https://example.com/",
				"Elements (1):",
				`[e1] link "More information"`,
				"Text:",
				"This domain is for use in examples.",
			].join("\n"));
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

function untypedNodes(schema: unknown, path: string): string[] {
	if (typeof schema !== "object" || schema === null) return [];
	const node = schema as Record<string, unknown>;
	const branches = (node.anyOf ?? node.oneOf ?? node.allOf) as unknown[] | undefined;
	if (branches) return branches.flatMap((branch, index) => untypedNodes(branch, `${path}|${index}`));
	const own = node.type === undefined ? [path] : [];
	const children = [
		...Object.entries((node.properties ?? {}) as Record<string, unknown>).map(([key, child]) => [`${path}.${key}`, child] as const),
		...Object.values((node.patternProperties ?? {}) as Record<string, unknown>).map((child) => [`${path}{}`, child] as const),
		...(typeof node.additionalProperties === "object" ? [[`${path}{}`, node.additionalProperties] as const] : []),
		...(node.items === undefined ? [] : [[`${path}[]`, node.items] as const]),
	];
	return [...own, ...children.flatMap(([childPath, child]) => untypedNodes(child, childPath))];
}

test("forkChat branches an edit into a new chat and leaves the original untouched", async () => {
	const errors: unknown[] = [];
	const broker = await serveBrowser(fakeBrowser(), (error) => errors.push(error));
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	const respond = () => {
		faux.appendResponses([respond]);
		return fauxAssistantMessage("Answer.");
	};
	faux.setResponses([respond]);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);
	const engine = await openEngine(broker, { models, onError: (error) => errors.push(error) });
	const panel = await connectPanel(engine);
	await useModel(panel.workspace, faux);

	const userEntries = (chat: ChatRef) => (chat.view.value?.entries ?? []).filter((entry) => entry.kind === "pi.user" || entry.kind === USER_ENTRY);
	const userTexts = (chat: ChatRef) => userEntries(chat).flatMap((entry) => {
		const message = entry.model?.find((item) => item.role === "user");
		return message?.role === "user" ? [userInput(entry, message.content).text] : [];
	});
	const settled = (chat: ChatRef, users: number) =>
		userEntries(chat).length === users && (chat.view.value?.docs["pi.live"] as { run?: unknown } | undefined)?.run === undefined ? true : undefined;

	const id = await panel.workspace.createChat({}, context);
	const chat = await panel.chat(id);
	await chat.send({ text: "first question", requestId: "r1" }, context);
	await until(() => settled(chat, 1), "the first answer");
	await chat.send({ text: "second question", requestId: "r2" }, context);
	await until(() => settled(chat, 2), "the second answer");
	const parentTexts = userTexts(chat);
	assert.deepEqual(parentTexts, ["first question", "second question"]);

	// Editing the second message: the branch keeps the first turn, drops the original second input, resends the edit.
	const before = panel.workspace.chats.value.length;
	const secondUser = userEntries(chat)[1]!.id;
	const branchId = await panel.workspace.forkChat({ id, entry: secondUser, title: "Parent (branch)", text: "edited second", requestId: "f1" }, context);
	assert.notEqual(branchId, id);
	const branch = await panel.chat(branchId);
	const branchTexts = await until(() => {
		const texts = userTexts(branch);
		return texts.includes("edited second") ? texts : undefined;
	}, "the edited input in the branch");
	assert.deepEqual(branchTexts, ["first question", "edited second"]);
	const branchEntries = branch.view.value?.entries ?? [];
	const editedAt = branchEntries.findIndex((entry) => {
		const message = entry.model?.find((item) => item.role === "user");
		return message?.role === "user" && userInput(entry, message.content).text === "edited second";
	});
	assert.ok(branchEntries.slice(0, editedAt).some((entry) => entry.kind === "pi.assistant"), "the first turn's answer came along");
	assert.deepEqual(userTexts(chat), parentTexts, "the parent's history is unchanged");
	await until(() => panel.workspace.chats.value.length === before + 1 || undefined, "the branch in the chat list");

	// The same request returns the same chat instead of forking again.
	const again = await panel.workspace.forkChat({ id, entry: secondUser, title: "Parent (branch)", text: "edited second", requestId: "f1" }, context);
	assert.equal(again, branchId);
	assert.equal(panel.workspace.chats.value.length, before + 1);

	// The first message has no earlier entry: a fresh conversation still resends the original input.
	const firstUser = userEntries(chat)[0]!.id;
	const emptyId = await panel.workspace.forkChat({ id, entry: firstUser, title: "First (branch)", requestId: "f2" }, context);
	const empty = await panel.chat(emptyId);
	const emptyTexts = await until(() => (userTexts(empty).length ? userTexts(empty) : undefined), "the resent first input");
	assert.deepEqual(emptyTexts, ["first question"]);

	// Attachments keep their paths, which the copied files resolve in the branch.
	const fileId = await panel.workspace.createChat({}, context);
	const fileChat = await panel.chat(fileId);
	await fileChat.send({ text: "plain first", requestId: "r3" }, context);
	await until(() => settled(fileChat, 1), "the file chat's first answer");
	const bytes = new TextEncoder().encode("attachment body");
	await fileChat.send({ text: "with a file", requestId: "r4", attachments: [{ id: "a1", name: "note.txt", mimeType: "text/plain", data: bytes }] }, context);
	const attachEntry = await until(() => userEntries(fileChat)[1], "the attachment input");
	const attachMessage = attachEntry.model?.find((item) => item.role === "user");
	const attachPath = attachMessage?.role === "user" ? userInput(attachEntry, attachMessage.content).attachments[0]?.path : undefined;
	assert.ok(attachPath);
	const filesId = await panel.workspace.forkChat({ id: fileId, entry: attachEntry.id, title: "Files (branch)", text: "kept file", requestId: "f3" }, context);
	const filesBranch = await panel.chat(filesId);
	const resent = await until(() => {
		const entries = userEntries(filesBranch);
		const last = entries.at(-1);
		const message = last?.model?.find((item) => item.role === "user");
		const attachments = message?.role === "user" ? userInput(last, message.content).attachments : [];
		return attachments.length ? attachments : undefined;
	}, "the resent input's attachments");
	assert.deepEqual(resent.map((item) => item.path), [attachPath]);
	const relative = attachPath.replace("/workspace/", "");
	const file = await until(async () => (await filesBranch.files(context)).find((item) => item.path === relative), "the copied attachment file");
	assert.ok(file);
	assert.deepEqual(new Uint8Array(await filesBranch.readFile({ path: file.path }, context)), bytes);

	await panel.close();
	await engine.close();
	await broker.close(context);
	assert.deepEqual(
		errors.filter((error) => !/closed|released|aborted/i.test(JSON.stringify(error) + String(error))),
		[],
	);
});
