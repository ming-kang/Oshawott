import assert from "node:assert/strict";
import { test } from "node:test";
import { fromBase64, portLink, toBase64 } from "../src/link/port-link.ts";
import { fakePortPair } from "./fake-port.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("bytes survive a JSON-serializing port, in order", async () => {
	const [a, b] = fakePortPair();
	const left = portLink(a);
	const right = portLink(b);
	const got: number[][] = [];
	right.onMessage((message) => got.push([...message]));
	left.send(new Uint8Array([0, 1, 255]));
	left.send(new Uint8Array([]));
	left.send(new Uint8Array([7]));
	await tick();
	assert.deepEqual(got, [[0, 1, 255], [], [7]]);
});

test("messages that arrive before the listener are queued for it", async () => {
	const [a, b] = fakePortPair();
	const left = portLink(a);
	const right = portLink(b);
	left.send(new Uint8Array([1]));
	await tick();
	const got: number[][] = [];
	right.onMessage((message) => got.push([...message]));
	assert.deepEqual(got, [[1]]);
});

test("close ends both sides once, and a late close listener runs at once", async () => {
	const [a, b] = fakePortPair();
	const left = portLink(a);
	const right = portLink(b);
	let leftClosed = 0;
	let rightClosed = 0;
	left.onClose(() => leftClosed++);
	right.onClose(() => rightClosed++);
	left.close();
	left.close();
	await tick();
	assert.equal(leftClosed, 1);
	assert.equal(rightClosed, 1);
	assert.equal(right.reason, "disconnected");
	let late = 0;
	right.onClose(() => late++);
	assert.equal(late, 1);
	// Sending on a closed link is a no-op.
	left.send(new Uint8Array([1]));
});

test("a frame that is no string closes the link", async () => {
	const [a, b] = fakePortPair();
	const right = portLink(b);
	let closed = false;
	right.onClose(() => (closed = true));
	a.postMessage({ not: "ours" });
	await tick();
	assert.equal(closed, true);
	assert.equal(right.reason, "unexpected message");
});

test("base64 round trip, larger than one chunk", () => {
	const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) & 255);
	assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});
