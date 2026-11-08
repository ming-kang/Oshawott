import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IndexedDbCredentialStore } from "../src/engine/credentials.ts";

test("credentials round trip through committed transactions", async () => {
	const store = new IndexedDbCredentialStore(`oshawott-credentials-${crypto.randomUUID()}`);
	await store.modify("openai", async () => ({ type: "api_key", key: "sk-1" }));
	assert.deepEqual(await store.read("openai"), { type: "api_key", key: "sk-1" });
	assert.deepEqual(await store.list(), [{ providerId: "openai", type: "api_key" }]);
	await store.delete("openai");
	assert.equal(await store.read("openai"), undefined);
});

test("a write whose transaction aborts after the request succeeded is reported as failed", async () => {
	const store = new IndexedDbCredentialStore(`oshawott-credentials-${crypto.randomUUID()}`);
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
		const request = put.apply(this, args);
		request.addEventListener("success", () => this.transaction.abort());
		return request;
	};
	try {
		await assert.rejects(store.modify("openai", async () => ({ type: "api_key", key: "sk-lost" })));
	} finally {
		IDBObjectStore.prototype.put = put;
	}
	assert.equal(await store.read("openai"), undefined);
	await store.modify("openai", async () => ({ type: "api_key", key: "sk-2" }));
	assert.deepEqual(await store.read("openai"), { type: "api_key", key: "sk-2" }, "the write line continues after a failure");
});
