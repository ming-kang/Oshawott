import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "./support/wait.ts";

const listeners = new Set<() => void>();
let granted = false;
let requestResult: Promise<boolean>;
let requested = false;
const event = {
	addListener: (listener: () => void) => listeners.add(listener),
	removeListener: (listener: () => void) => listeners.delete(listener),
};
(globalThis as { browser?: unknown }).browser = {
	permissions: {
		contains: async () => granted,
		request: () => {
			requested = true;
			return requestResult;
		},
		onAdded: event,
		onRemoved: event,
	},
};
const { SiteAccess } = await import("../src/panel/site-access.ts");

test("site access tracks revocation and requests synchronously, recovering from denial and errors", async () => {
	const access = new SiteAccess();
	access.start();
	await until(() => !access.granted.value);
	granted = true;
	for (const listener of listeners) listener();
	await until(() => access.granted.value);
	granted = false;
	for (const listener of listeners) listener();
	await until(() => !access.granted.value);

	requestResult = Promise.resolve(false);
	access.request();
	assert.equal(requested, true);
	await until(() => !access.requesting.value);
	assert.equal(access.granted.value, false);
	assert.equal(access.error.value, false);

	requestResult = Promise.reject(new Error("request failed"));
	access.request();
	await until(() => access.error.value && !access.requesting.value);
	requestResult = Promise.resolve(true);
	access.request();
	await until(() => access.granted.value && !access.requesting.value);
	assert.equal(access.error.value, false);
	access.stop();
	assert.equal(listeners.size, 0);
});
