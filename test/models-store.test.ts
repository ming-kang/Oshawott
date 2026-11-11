import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelsStoreEntry } from "@earendil-works/pi-ai";
import { IndexedDbModelsStore } from "../src/engine/models-store.ts";

const first: ModelsStoreEntry = {
	models: [
		{
			id: "gpt-test",
			name: "GPT Test",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.test/v1",
			input: ["text", "image"],
			cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
			reasoning: true,
			contextWindow: 128_000,
			maxTokens: 16_000,
		},
	],
	lastModified: 1_700_000_000_000,
	checkedAt: 1_700_000_100_000,
	etag: '"catalog-v1"',
};

const replacement: ModelsStoreEntry = {
	models: [
		{
			id: "claude-test",
			name: "Claude Test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://example.test/anthropic",
			input: ["text"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			reasoning: false,
			contextWindow: 200_000,
			maxTokens: 8_000,
		},
	],
	checkedAt: 1_700_000_200_000,
};

test("model catalogs round trip, replace, delete, survive reopening, and read unknown providers as undefined", async () => {
	const name = `oshawott-models-${crypto.randomUUID()}`;
	const store = new IndexedDbModelsStore(name);
	assert.equal(await store.read("missing"), undefined);
	await store.write("openai", first);
	assert.deepEqual(await new IndexedDbModelsStore(name).read("openai"), first);
	await store.write("openai", replacement);
	assert.deepEqual(await store.read("openai"), replacement);
	await store.delete("openai");
	assert.equal(await store.read("openai"), undefined);
});

test("already-aborted operations reject with the abort reason without mutating data", async () => {
	const store = new IndexedDbModelsStore(`oshawott-models-${crypto.randomUUID()}`);
	await store.write("openai", first);
	const controller = new AbortController();
	const reason = new DOMException("Caller cancelled", "AbortError");
	controller.abort(reason);
	for (const operation of [
		() => store.read("openai", { signal: controller.signal }),
		() => store.write("openai", replacement, { signal: controller.signal }),
		() => store.delete("openai", { signal: controller.signal }),
	]) {
		await assert.rejects(operation(), (error) => {
			assert.equal(error, reason);
			return true;
		});
	}
	assert.deepEqual(await store.read("openai"), first);
});

test("aborting a write after its request succeeds prevents the transaction from committing", async () => {
	const store = new IndexedDbModelsStore(`oshawott-models-${crypto.randomUUID()}`);
	const controller = new AbortController();
	const reason = new DOMException("Write cancelled", "AbortError");
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
		const request = put.apply(this, args);
		request.addEventListener("success", () => controller.abort(reason));
		return request;
	};
	try {
		await assert.rejects(store.write("openai", first, { signal: controller.signal }), (error) => {
			assert.equal(error, reason);
			return true;
		});
	} finally {
		IDBObjectStore.prototype.put = put;
	}
	assert.equal(await store.read("openai"), undefined);
});

test("a transaction aborted after a successful write request rejects instead of reporting success", async () => {
	const store = new IndexedDbModelsStore(`oshawott-models-${crypto.randomUUID()}`);
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
		const request = put.apply(this, args);
		request.addEventListener("success", () => this.transaction.abort());
		return request;
	};
	try {
		await assert.rejects(store.write("openai", first), { name: "AbortError" });
	} finally {
		IDBObjectStore.prototype.put = put;
	}
	assert.equal(await store.read("openai"), undefined);
});
