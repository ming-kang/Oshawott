// Exercise the actual IndexedDB backend in Node as well as the real-browser smoke tests. The supported Durable
// conformance cases must work on both backends; failed transactions must roll back metadata and bytes together.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { ChatFiles, type Entry } from "../src/engine/files.ts";
import { IndexedDbFileBackend } from "../src/engine/files-idb.ts";
import { BACKGROUND_CONTEXT } from "../src/lib/chord.ts";

const context = BACKGROUND_CONTEXT;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);
const entry = (value: string): Entry => ({ kind: "file", size: bytes(value).length, mtimeMs: 42 });

async function withBackend(use: (backend: IndexedDbFileBackend, name: string) => Promise<void>) {
	const name = `oshawatt-files-test-${crypto.randomUUID()}`;
	const backend = await IndexedDbFileBackend.open(name);
	try {
		await use(backend, name);
	} finally {
		backend.close();
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(name);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	}
}

for (const conformance of createEnvConformance({
	assertions: {
		ok: (value, message) => assert.ok(value, message),
		strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
		deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
		partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
		greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
		rejects: (operation, includes) => assert.rejects(operation, (error: Error) => error.message.includes(includes)),
	},
	withEnv: (use) => withBackend((backend) => use(new ChatFiles(backend, 1))),
	symlinks: false,
	listFiles: true,
})) {
	if (/^watch|exec|git ignores|symbolic/.test(conformance.name)) continue;
	test(`IndexedDB conformance: ${conformance.name}`, () => conformance.run());
}

for (const failure of ["synchronous", "asynchronous", "cloning"] as const) {
	test(`IndexedDB rolls back both stores on ${failure} failure after queued writes`, () => withBackend(async (backend) => {
		await backend.transact(1, "readwrite", async (tx) => { tx.put("/workspace/base.txt", entry("base"), bytes("base")); });
		await assert.rejects(backend.transact(1, "readwrite", (tx) => {
			tx.put("/workspace/ghost.txt", entry("ghost"), bytes("ghost"));
			if (failure === "synchronous") throw new Error("simulated failure");
			if (failure === "cloning") {
				tx.put("/workspace/bad.txt", entry("bad"), (() => {}) as unknown as Uint8Array);
			}
			return tx.get("/workspace/ghost.txt").then(() => { throw new Error("simulated failure"); });
		}));
		await backend.transact(1, "readonly", async (tx) => {
			assert.deepEqual(await tx.data("/workspace/base.txt"), bytes("base"));
			for (const path of ["/workspace/ghost.txt", "/workspace/bad.txt"]) {
				assert.equal(await tx.get(path), undefined, `${path}: metadata`);
				assert.equal(await tx.data(path), undefined, `${path}: bytes`);
			}
		});
	}));
}

test("IndexedDB preserves files on reopen, serializes appends, renames subtrees, and isolates clear", () => withBackend(async (backend, name) => {
	const one = new ChatFiles(backend, 1, () => 42);
	const two = new ChatFiles(backend, 2, () => 43);
	getOrThrow(await one.writeFile("data/nested/value.txt", "0", context));
	getOrThrow(await two.writeFile("data/nested/value.txt", "other", context));
	await Promise.all(["1", "2", "3"].map(async (value) => getOrThrow(await one.appendFile("data/nested/value.txt", value, context))));
	getOrThrow(await one.renameFile("data", "moved", context));
	backend.close();
	const reopened = await IndexedDbFileBackend.open(name);
	try {
		const files = new ChatFiles(reopened, 1);
		assert.equal(getOrThrow(await files.readTextFile("moved/nested/value.txt", context)), "0123");
		assert.deepEqual(getOrThrow(await files.workspaceFiles(context)).map((file) => file.path), ["moved/nested/value.txt"]);
		assert.equal(getOrThrow(await files.fileInfo("moved/nested/value.txt", context)).mtimeMs, 42);
		await reopened.clear(1);
		assert.deepEqual(getOrThrow(await files.workspaceFiles(context)), []);
		assert.equal(getOrThrow(await new ChatFiles(reopened, 2).readTextFile("data/nested/value.txt", context)), "other");
	} finally {
		reopened.close();
	}
}));
