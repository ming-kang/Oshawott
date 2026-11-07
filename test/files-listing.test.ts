// All listing surfaces share one metadata read and depth-first order, regardless of backend insertion order.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { Principal } from "../src/contracts/hosts.ts";
import { ChatFiles, type FileBackend, MemoryFileBackend } from "../src/engine/files.ts";
import { IndexedDbFileBackend } from "../src/engine/files-idb.ts";
import { filesExtension } from "../src/engine/files-tools.ts";
import { BACKGROUND_CONTEXT, createHost } from "../src/lib/chord.ts";

const context = BACKGROUND_CONTEXT;
const fixture = ["top.txt", "skip/file.txt", "a.txt", "a/z.txt", "a/deep/end.txt", ".git/config", ".cache/kept.txt"];
const depthFirst = [".cache", ".cache/kept.txt", ".git", ".git/config", "a", "a/deep", "a/deep/end.txt", "a/z.txt", "a.txt", "skip", "skip/file.txt", "top.txt"];

for (const kind of ["memory", "indexeddb"] as const) {
	test(`${kind}: tree, ls and Panel listings share one read without changing their policies`, async () => {
		const name = `oshawott-listing-${crypto.randomUUID()}`;
		const backend = kind === "memory" ? new MemoryFileBackend() : await IndexedDbFileBackend.open(name);
		let reads = 0;
		const counted: FileBackend = {
			transact: (chat, mode, fn) => {
				if (mode === "readonly") reads++;
				return backend.transact(chat, mode, fn);
			},
			clear: (chat) => backend.clear(chat),
		};
		const files = new ChatFiles(counted, 1, () => 42);
		const host = createHost<Principal>({ onError: () => {} });
		try {
			for (const path of fixture) getOrThrow(await files.writeFile(path, "x", context));
			const tree = getOrThrow(await files.listTree(".", context));
			assert.deepEqual(tree.map((entry) => entry.path), depthFirst);
			assert.equal(reads, 1);
			assert.deepEqual(getOrThrow(await files.listTree("a", context)).map((entry) => entry.path), ["deep", "deep/end.txt", "z.txt"]);
			assert.deepEqual(getOrThrow(await files.listTree("/", context)).map((entry) => entry.path), ["workspace", ...depthFirst.map((path) => `workspace/${path}`)]);

			reads = 0;
			const tool = filesExtension({ host, fetch }).tools!.find((tool) => tool.name === "ls")!;
			const result = await tool.execute({}, { env: files } as unknown as ToolExecutionApi, context);
			assert.deepEqual(result.structuredOutput, tree.map(({ path, kind, size }) => ({ path, kind, size })));
			assert.equal(reads, 1, "ls does not open another transaction for every directory");

			reads = 0;
			const panel = getOrThrow(await files.workspaceFiles(context));
			assert.deepEqual(panel, [...fixture].sort().map((path) => ({ path, size: 1, mtimeMs: 42 })));
			assert.equal(reads, 1);

			reads = 0;
			const listing = getOrThrow(await files.listFiles(".", { hidden: false, exclude: ["skip"] }, context));
			assert.deepEqual(listing, {
				entries: ["a", "a/deep", "a/deep/end.txt", "a/z.txt", "a.txt", "top.txt"].map((path) => ({ path, kind: path === "a" || path === "a/deep" ? "directory" : "file" })),
				truncated: false,
			});
			assert.equal(reads, 1);
			assert.equal(getOrThrow(await files.listFiles(".", undefined, context)).entries.some((entry) => entry.path.startsWith(".git")), false);
			assert.deepEqual(getOrThrow(await files.listFiles("a", { maxEntries: 2 }, context)), {
				entries: [{ path: "deep", kind: "directory" }, { path: "deep/end.txt", kind: "file" }], truncated: true,
			});
			assert.equal(getOrThrow(await files.listFiles("a", { maxBytes: 5 }, context)).entries.length, 0);
			const missing = await files.listFiles("missing", undefined, context);
			assert.equal(!missing.ok && missing.error.code, "not_found");
			const notDirectory = await files.listTree("a.txt", context);
			assert.equal(!notDirectory.ok && notDirectory.error.code, "not_directory");
			getOrThrow(await files.writeFile("unicode/汉字.txt", "x", context));
			assert.deepEqual(getOrThrow(await files.listFiles("unicode", { maxBytes: 11 }, context)), { entries: [], truncated: true });
			assert.deepEqual(getOrThrow(await files.listFiles("unicode", { maxBytes: 12 }, context)), { entries: [{ path: "汉字.txt", kind: "file" }], truncated: false });
		} finally {
			await host.close(context);
			if (backend instanceof IndexedDbFileBackend) {
				backend.close();
				await new Promise<void>((resolve, reject) => {
					const request = indexedDB.deleteDatabase(name);
					request.onsuccess = () => resolve();
					request.onerror = () => reject(request.error);
				});
			}
		}
	});
}

test("ls preserves its 1000-entry cap and rejects an environment outside this extension", async () => {
	const backend = new MemoryFileBackend();
	await backend.transact(1, "readwrite", async (tx) => {
		for (let i = 1000; i >= 0; i--) tx.put(`/workspace/${String(i).padStart(4, "0")}`, { kind: "file", size: 0, mtimeMs: 0 }, new Uint8Array());
	});
	const host = createHost<Principal>({ onError: () => {} });
	try {
		const tool = filesExtension({ host, fetch }).tools!.find((tool) => tool.name === "ls")!;
		const result = await tool.execute({}, { env: new ChatFiles(backend, 1) } as unknown as ToolExecutionApi, context);
		assert.equal((result.structuredOutput as unknown[]).length, 1000);
		assert.match(result.output!.map((block) => block.type === "text" ? block.text : "").join(""), /Stopped at 1000 entries/);
		await assert.rejects(tool.execute({}, {} as ToolExecutionApi, context), /no files/);
	} finally {
		await host.close(context);
	}
});
