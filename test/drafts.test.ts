import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";
import { DraftStore } from "../src/panel/drafts.ts";

const encoder = new TextEncoder();
const attachment = { id: "one", name: "one.txt", mimeType: "text/plain", data: encoder.encode("persisted bytes") };

test("composer drafts are isolated by chat and survive a database reopen", async () => {
	const name = `draft-test-${crypto.randomUUID()}`;
	let store = await DraftStore.open(name);
	await store.save(undefined, { text: "new chat", attachments: [attachment], updatedAt: 1 });
	await store.save(10, { text: "ten", attachments: [], updatedAt: 2 });
	await store.save(20, { text: "twenty", attachments: [], updatedAt: 3 });
	assert.equal((await store.load(10))?.text, "ten");
	assert.equal((await store.load(20))?.text, "twenty");
	store.close();
	store = await DraftStore.open(name);
	assert.deepEqual(await store.load(undefined), { text: "new chat", attachments: [attachment], updatedAt: 1 });
	await store.remove(10);
	assert.equal(await store.load(10), undefined);
	assert.equal((await store.load(20))?.text, "twenty");
	await store.save(20, { text: "", attachments: [], updatedAt: 4 });
	assert.equal(await store.load(20), undefined);
	store.close();
});
