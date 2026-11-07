import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Browser, NO_ACCESS } from "../src/contracts/browser.ts";
import { BrokerHost, EngineHost, type Principal } from "../src/contracts/hosts.ts";
import { ChatFiles, MAX_FILE_BYTES, MemoryFileBackend } from "../src/engine/files.ts";
import { filesExtension, MAX_READ_CHARS } from "../src/engine/files-tools.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet, memoryLinkPair, type Context } from "../src/lib/chord.ts";
import { formatBytes } from "../src/lib/bytes.ts";
import { sitePattern } from "../src/platform/patterns.ts";

const context = BACKGROUND_CONTEXT;
type FetchCall = (args: Record<string, unknown>, ctx?: Context) => Promise<ToolExecutionResult>;

async function withFetch(network: typeof fetch, use: (call: FetchCall, files: ChatFiles) => Promise<void>, allowed = (url: string) => new URL(url).hostname === "data.example") {
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError: () => {} });
	await broker.load([{ name: "broker", facet: defineFacet<Principal>((host) => {
		host.serve(Browser, () => ({ variant: "engine", members: {
			listTabs: async () => [], activeTab: async () => null,
			openTab: async () => { throw new Error("unused"); }, attach: async () => null,
			hasAccess: async ({ url }) => allowed(url), armWake: async () => null,
		} }));
	}) }], context);
	const host = createHost<Principal>({ address: EngineHost(), principal: { kind: "engine" }, onError: () => {} });
	host.route(BrokerHost, { authorize: (principal) => principal.kind === "engine", resolve: async () => {
		const [engineEnd, brokerEnd] = memoryLinkPair();
		broker.accept(brokerEnd, { principal: { kind: "engine" } }, context);
		return { link: engineEnd, principal: { kind: "broker" } };
	} }, context);
	await host.load([], context);
	const files = new ChatFiles(new MemoryFileBackend(), 1);
	const tool = filesExtension({ host, fetch: network }).tools!.find((tool) => tool.name === "fetch")!;
	const call: FetchCall = (args, ctx = context) => tool.execute(args, { env: files } as unknown as ToolExecutionApi, ctx);
	try {
		await use(call, files);
	} finally {
		await host.close(context);
		await broker.close(context);
	}
}

const valueOf = (result: ToolExecutionResult) => result.structuredOutput as { bytes: number; body?: string; truncated?: boolean; savedTo?: string };

test("fetch refuses invalid schemes and unauthorized sites before requesting or writing", async () => {
	let requests = 0;
	await withFetch(async () => { requests++; return new Response("never"); }, async (call, files) => {
		await assert.rejects(call({ url: "https://other.example/private", saveTo: "private.txt" }), (error: Error) => error.message.includes(NO_ACCESS));
		await assert.rejects(call({ url: "file:///private.txt" }), /Only http and https/);
		await assert.rejects(call({ url: "not a URL" }), /Not a URL/);
		assert.equal(requests, 0);
		assert.equal(getOrThrow(await files.exists("private.txt", context)), false);
	});
});

test("fetch truncates text, preserves binary bytes on disk, and sets safe request options", async () => {
	const requests: RequestInit[] = [];
	await withFetch(async (input, init) => {
		requests.push(init!);
		if (String(input).endsWith("/binary")) return new Response(new Uint8Array([0, 255, 128, 1]), { headers: { "content-type": "application/octet-stream" } });
		if (String(input).endsWith("/latin")) return new Response(new Uint8Array([233]), { headers: { "content-type": "text/plain; charset=iso-8859-1" } });
		return new Response('{"items":[1,2,3]}', { headers: { "content-type": "application/json" } });
	}, async (call, files) => {
		assert.deepEqual(valueOf(await call({ url: "https://data.example/text", maxChars: 5 })), {
			status: 200, statusText: "", url: "https://data.example/text", contentType: "application/json", bytes: 17, body: '{"ite', truncated: true,
		});
		const saved = valueOf(await call({ url: "https://data.example/binary", saveTo: "nested/data.bin", method: "POST", body: "input" }));
		assert.equal(saved.savedTo, "/workspace/nested/data.bin");
		assert.equal(saved.body, undefined);
		assert.deepEqual(getOrThrow(await files.readBinaryFile("nested/data.bin", context)), new Uint8Array([0, 255, 128, 1]));
		assert.equal(valueOf(await call({ url: "https://data.example/binary" })).body, undefined);
		assert.equal(valueOf(await call({ url: "https://data.example/latin" })).body, "é");
		assert.equal(valueOf(await call({ url: "https://data.example/text", method: "HEAD", body: "ignored" })).bytes, 0);
		assert.equal(requests[1]?.body, "input");
		assert.equal(requests.at(-1)?.body, undefined);
		for (const request of requests) {
			assert.equal(request.credentials, "omit");
			assert.equal(request.referrerPolicy, "no-referrer");
			assert.equal(request.cache, "no-store");
			assert.equal(request.redirect, "error");
			assert.ok(request.signal instanceof AbortSignal);
		}
	});
});

test("fetch cancels an oversized body and does not replace the destination file", async () => {
	let cancelled = false;
	await withFetch(async () => new Response(new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new Uint8Array(MAX_FILE_BYTES + 1)); },
		cancel() { cancelled = true; },
	})), async (call, files) => {
		getOrThrow(await files.writeFile("kept.txt", "old", context));
		await assert.rejects(call({ url: "https://data.example/large", saveTo: "kept.txt" }), /larger than 20 MiB/);
		assert.equal(cancelled, true);
		assert.equal(getOrThrow(await files.readTextFile("kept.txt", context)), "old");
	});
});

test("fetch rejects redirects instead of sending an unchecked request to a different host", async () => {
	let targetRequests = 0;
	const server = createServer((req, res) => {
		if (req.url === "/redirect") {
			res.writeHead(302, { location: `http://localhost:${(server.address() as { port: number }).port}/target` }).end();
		} else {
			targetRequests++;
			res.end("must not be reached");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		await withFetch(fetch, async (call) => {
			const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/redirect`;
			await assert.rejects(call({ url }), /Redirects are not followed/);
			assert.equal(targetRequests, 0);
		}, (url) => new URL(url).hostname === "127.0.0.1");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
});

test("read_text keeps full large single lines available to programs in bounded chunks", async () => {
	const host = createHost<Principal>({ onError: () => {} });
	const files = new ChatFiles(new MemoryFileBackend(), 1);
	const tool = filesExtension({ host, fetch }).tools!.find((tool) => tool.name === "read_text")!;
	const api = { env: files } as unknown as ToolExecutionApi;
	const source = "x".repeat(MAX_READ_CHARS + 3) + "💧end";
	getOrThrow(await files.writeFile("large.txt", `\ufeff${source}`, context));
	try {
		const first = await tool.execute({ path: "large.txt" }, api, context);
		const chunk = first.structuredOutput as { text: string; nextOffset: number; totalChars: number; eof: boolean };
		assert.equal(chunk.text.length, MAX_READ_CHARS);
		assert.equal(chunk.eof, false);
		assert.equal(chunk.totalChars, source.length);
		const next = (await tool.execute({ path: "large.txt", offset: chunk.nextOffset }, api, context)).structuredOutput as typeof chunk;
		assert.equal(chunk.text + next.text, source);
		assert.equal(next.eof, true);
		assert.deepEqual(tool.callers, ["tools"]);
		assert.ok((first.output?.map((block) => block.type === "text" ? block.text : "").join("") ?? "").length < 1000, "the preview does not dump the full chunk");
	} finally {
		await host.close(context);
	}
});

test("read_text character chunks reassemble Unicode, strip BOM and support explicit encodings", async () => {
	const host = createHost<Principal>({ onError: () => {} });
	const files = new ChatFiles(new MemoryFileBackend(), 1);
	const tool = filesExtension({ host, fetch }).tools!.find((tool) => tool.name === "read_text")!;
	const api = { env: files } as unknown as ToolExecutionApi;
	getOrThrow(await files.writeFile("unicode.txt", "\ufeffab💧汉字z", context));
	getOrThrow(await files.writeFile("latin.txt", new Uint8Array([233]), context));
	try {
		const parts: string[] = [];
		for (let offset = 0; ; ) {
			const result = (await tool.execute({ path: "unicode.txt", offset, maxChars: 3 }, api, context)).structuredOutput as { text: string; nextOffset: number; eof: boolean };
			parts.push(result.text);
			if (result.eof) break;
			offset = result.nextOffset;
		}
		assert.equal(parts.join(""), "ab💧汉字z");
		assert.equal(((await tool.execute({ path: "latin.txt", encoding: "windows-1252" }, api, context)).structuredOutput as { text: string }).text, "é");
		await assert.rejects(tool.execute({ path: "latin.txt" }, api, context));
	} finally {
		await host.close(context);
	}
});

test("site patterns omit ports on both browsers and sizes use binary units", () => {
	assert.equal(sitePattern("https://example.com:8443/path?q=1"), "https://example.com/*");
	assert.equal(sitePattern("http://127.0.0.1:1234/"), "http://127.0.0.1/*");
	assert.equal(sitePattern("file:///tmp/private"), undefined);
	assert.equal(sitePattern("bad"), undefined);
	assert.deepEqual([0, 17, 1024, 1536, 20 * 1024 * 1024].map(formatBytes), ["0 B", "17 B", "1 KiB", "1.5 KiB", "20 MiB"]);
});
