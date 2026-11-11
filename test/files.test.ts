import { unusedTabActions } from "./fake-browser.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { Browser } from "../src/contracts/browser.ts";
import { Chat, Workspace } from "../src/contracts/chat.ts";
import { BrokerHost, type Principal } from "../src/contracts/hosts.ts";
import { startEngine } from "../src/engine/engine.ts";
import { ChatFiles, type FileTx, MAX_FILE_BYTES, MemoryFileBackend } from "../src/engine/files.ts";
import { NO_ACCESS } from "../src/contracts/browser.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet, withAbortSignal } from "../src/lib/chord.ts";
import { portLink } from "../src/link/port-link.ts";
import { fakePortPair } from "./fake-port.ts";

const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();

const UNSUPPORTED = /^watch|exec|git ignores|symbolic/;
for (const conformance of createEnvConformance({
	assertions: {
		ok: (value, message) => assert.ok(value, message),
		strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
		deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
		partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
		greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
		rejects: (operation, includes) => assert.rejects(operation, (error: Error) => error.message.includes(includes)),
	},
	withEnv: (use) => use(new ChatFiles(new MemoryFileBackend(), 1)),
	symlinks: false,
	listFiles: true,
})) {
	if (UNSUPPORTED.test(conformance.name)) continue;
	test(`conformance: ${conformance.name}`, () => conformance.run());
}

test("files: parents are created, directories move with their contents, and the working directory stays", async () => {
	const files = new ChatFiles(new MemoryFileBackend(), 1);
	getOrThrow(await files.writeFile("data/raw/a.csv", "x,y\n1,2\n", context));
	getOrThrow(await files.appendFile("data/raw/a.csv", "3,4\n", context));
	assert.equal(getOrThrow(await files.readTextFile("/workspace/data/raw/a.csv", context)), "x,y\n1,2\n3,4\n");
	assert.equal(getOrThrow(await files.fileInfo("data", context)).kind, "directory");

	getOrThrow(await files.renameFile("data", "moved", context));
	assert.equal(getOrThrow(await files.exists("data/raw/a.csv", context)), false);
	assert.deepEqual(
		getOrThrow(await files.workspaceFiles(context)).map((file) => [file.path, file.size]),
		[["moved/raw/a.csv", 12]],
	);

	const refused = await files.remove("/workspace", { recursive: true }, context);
	assert.equal(!refused.ok && refused.error.code, "permission_denied");
	const intoFile = await files.writeFile("moved/raw/a.csv/inner.txt", "x", context);
	assert.equal(!intoFile.ok && intoFile.error.code, "not_directory");
	const tooLarge = await files.writeFile("big.bin", new Uint8Array(MAX_FILE_BYTES + 1), context);
	assert.equal(!tooLarge.ok && tooLarge.error.code, "invalid");

	getOrThrow(await files.remove("moved", { recursive: true }, context));
	assert.deepEqual(getOrThrow(await files.listDir(".", context)), []);
	const shell = await files.exec("ls", undefined, context);
	assert.equal(!shell.ok && shell.error.code, "shell_unavailable");
});

test("files: each chat has its own tree, and clearing a chat removes only its files", async () => {
	const backend = new MemoryFileBackend();
	const one = new ChatFiles(backend, 1);
	const two = new ChatFiles(backend, 2);
	getOrThrow(await one.writeFile("notes.md", "one", context));
	getOrThrow(await two.writeFile("notes.md", "two", context));
	assert.notEqual(one.id, two.id);
	assert.equal(getOrThrow(await two.readTextFile("notes.md", context)), "two");
	await backend.clear(1);
	assert.equal(getOrThrow(await one.exists("notes.md", context)), false);
	assert.equal(getOrThrow(await two.readTextFile("../workspace/./notes.md", context)), "two");
});

test("the virtual workspace is present in root directory and recursive listings", async () => {
	const files = new ChatFiles(new MemoryFileBackend(), 1);
	assert.deepEqual(getOrThrow(await files.listDir("/", context)).map((entry) => entry.path), ["/workspace"]);
	getOrThrow(await files.writeFile("notes.txt", "x", context));
	assert.deepEqual(getOrThrow(await files.listFiles("/", undefined, context)).entries, [
		{ path: "workspace", kind: "directory" }, { path: "workspace/notes.txt", kind: "file" },
	]);
});

test("joinPath preserves relative parent traversal and normalizes absolute paths", async () => {
	const files = new ChatFiles(new MemoryFileBackend(), 1);
	for (const [parts, expected] of [
		[["..", "a.txt"], "../a.txt"], [["a", "..", "..", "b"], "../b"],
		[["/workspace", "..", "tmp"], "/tmp"], [["/", "..", ".."], "/"], [[], "."],
	] as const) assert.equal(getOrThrow(await files.joinPath([...parts], context)), expected);
});

test("listFiles enforces its deadline after metadata reads and observes cancellation", async () => {
	class SlowBackend extends MemoryFileBackend {
		override transact<T>(chat: number, mode: "readonly" | "readwrite", fn: (tx: FileTx) => Promise<T>) {
			return super.transact(chat, mode, (tx) => fn({ ...tx, below: async (dir) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return tx.below(dir);
			} }));
		}
	}
	const files = new ChatFiles(new SlowBackend(), 1);
	getOrThrow(await files.writeFile("a.txt", "x", context));
	const listing = getOrThrow(await files.listFiles(".", { timeoutMs: 1 }, context));
	assert.deepEqual(listing, { entries: [], truncated: true });
	const controller = new AbortController();
	const read = files.listFiles(".", { timeoutMs: 1000 }, withAbortSignal(controller.signal, context));
	setTimeout(() => controller.abort(), 1);
	const stopped = await read;
	assert.equal(!stopped.ok && stopped.error.code, "aborted");
});

test("a model fetches into a file, Code Mode reads/writes/edits it, another site is refused; the panel downloads it", async () => {
	const errors: unknown[] = [];
	const onError = (error: unknown) => errors.push(error);

	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError });
	await broker.load(
		[
			{
				name: "broker",
				facet: defineFacet<Principal>((host) => {
					host.serve(Browser, () => ({
						variant: "engine",
						members: {
							...unusedTabActions, listTabs: async () => [],
							activeTab: async () => null,
							openTab: async () => {
								throw new Error("unused");
							},
							attach: async () => null,
							hasAccess: async ({ url }) => new URL(url).hostname === "data.example",
							armWake: async () => null,
						},
					}));
				}),
			},
		],
		context,
	);

	const requests: { url: string; init: RequestInit | undefined }[] = [];
	const network: typeof fetch = async (input, init) => {
		requests.push({ url: String(input), init });
		return new Response(JSON.stringify({ items: [1, 2, 3] }), { headers: { "content-type": "application/json" } });
	};

	const faux = fauxProvider({ models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("fetch", { url: "https://data.example/items.json", saveTo: "items.json" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: "items.json" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("codemode", { code: [
			'const { items } = JSON.parse(await tools.read({ path: "items.json" }));',
			'const total = items.reduce((sum, item) => sum + item, 0);',
			'const chunks = [];',
			'for (let offset = 0; ; ) {',
			'  const part = await tools.read_text({ path: "large.json", offset, maxChars: 8192 });',
			'  chunks.push(part.text); if (part.eof) break; offset = part.nextOffset;',
			'}',
			'const large = JSON.parse(chunks.join(""));',
			'await tools.write({ path: "summary.txt", content: "Total: " + total });',
			'await tools.edit({ path: "summary.txt", edits: [{ oldText: "Total:", newText: "Sum:" }] });',
			'const files = await tools.ls({});',
			'return { total, largeLength: large.padding.length, ending: large.ending, summary: await tools.read({ path: "summary.txt" }), files: files.map((file) => file.path) };',
		].join("\n") }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("ls", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("fetch", { url: "https://other.example/" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Saved items.json."),
	]);
	const models = createModels({ credentials: new InMemoryCredentialStore() });
	models.setProvider(faux.provider);

	const backend = new MemoryFileBackend();
	const engine = await startEngine(
		{
			storage: new MemoryStorage(),
			models,
			credentials: new InMemoryCredentialStore(),
			files: backend,
			fetch: network,
			extensions: [createCodemodeExtension({ sandbox: new InlineCodemodeSandbox({ wasm: loadQuickJSWasm() }), models: false })],
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
	const [panelEnd, engineEnd] = fakePortPair("oshawott:panel");
	engine.acceptPanel(portLink(engineEnd), "panel-1");
	const panel = createHost<Principal>({ onError });
	panel.connect(portLink(panelEnd), { principal: { kind: "engine" } }, context);
	await panel.load([], context);

	try {
		const workspace = await panel.get(Workspace, {}, context);
		assert.equal(workspace.variant, "owner");
		const model = faux.getModel();
		await workspace.setDefaultConfiguration({ model: { provider: model.provider, modelId: model.id } }, context);
		const id = await workspace.createChat({}, context);
		const large = JSON.stringify({ padding: "x".repeat(64 * 1024), ending: "complete" });
		getOrThrow(await new ChatFiles(backend, id).writeFile("large.json", large, context));
		const chat = await panel.get(Chat, { id }, context);
		assert.equal(chat.variant, "owner");
		await chat.send({ text: "Save the items.", requestId: "r1" }, context);

		type Result = { kind: string; model?: { toolName?: string; isError?: boolean; details?: unknown; content?: { type: string; text?: string }[] }[] };
		const results = await until(() => {
			const entries = (chat.view.value?.entries ?? []) as readonly Result[];
			const done = entries.at(-1)?.kind === "pi.assistant" && entries.filter((entry) => entry.kind === "pi.tool-result").length === 5;
			return done ? entries.filter((entry) => entry.kind === "pi.tool-result").map((entry) => entry.model![0]!) : undefined;
		}, "five tool results and the answer");
		const textOf = (result: (typeof results)[number]) => result.content?.map((block) => block.text ?? "").join("") ?? "";
		const [fetched, read, code, listed, refused] = results;

		assert.equal(requests.length, 1, "the refused site was never requested");
		assert.equal(requests[0]?.init?.credentials, "omit");
		assert.match(textOf(fetched!), /HTTP 200 · application\/json · 17 bytes\nSaved the body to \/workspace\/items\.json\./);
		assert.deepEqual(fetched!.details, { http: { status: 200, bytes: 17 } });
		assert.equal(textOf(read!), '{"items":[1,2,3]}');
		assert.equal(code!.isError, false, textOf(code!));
		assert.match(textOf(code!), /"total":6/);
		assert.match(textOf(code!), /"largeLength":65536/);
		assert.match(textOf(code!), /"ending":"complete"/);
		assert.match(textOf(code!), /"summary":"Sum: 6"/);
		assert.match(textOf(listed!), /items\.json {2}\(17 bytes\)/);
		assert.match(textOf(listed!), /summary\.txt {2}\(6 bytes\)/);
		assert.equal(refused!.isError, true);
		assert.equal(textOf(refused!), `<harness>\n[error] ${NO_ACCESS} other.example: the user has not allowed Oshawott on this site. They can allow it from this call in the panel; then try again.\n</harness>`);
		assert.deepEqual(refused!.details, { access: { url: "https://other.example/" } });
		const deniedEntry = chat.view.value?.entries.find((entry) => entry.model?.[0]?.role === "toolResult" && entry.model[0].isError);
		assert.ok(ToolResultEntry.is(deniedEntry));
		assert.equal(deniedEntry.data.diagnostics[0]?.code, "no_access");

		assert.deepEqual(
			(await chat.files(context)).map((file) => [file.path, file.size]),
			[["items.json", 17], ["large.json", new TextEncoder().encode(large).length], ["summary.txt", 6]],
		);
		assert.equal(decoder.decode(await chat.readFile({ path: "items.json" }, context)), '{"items":[1,2,3]}');
		await assert.rejects(chat.readFile({ path: "../../tmp/x" }, context), /Not a file of this chat/);
		await assert.rejects(chat.removeFile({ path: "/tmp/x" }, context), /Not a file of this chat/);
		await chat.removeFile({ path: "summary.txt" }, context);
		assert.deepEqual((await chat.files(context)).map((file) => file.path), ["items.json", "large.json"]);

		await workspace.deleteChat({ id }, context);
		assert.deepEqual(getOrThrow(await new ChatFiles(backend, id).workspaceFiles(context)), []);

	} finally {
		await panel.close(context);
		await engine.close();
		await broker.close(context);
	}
	assert.deepEqual(
		errors.filter((error) => !/closed|released|aborted/i.test(JSON.stringify(error) + String(error))),
		[],
	);
});

async function until<T>(read: () => T | undefined, what: string, ms = 5_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
