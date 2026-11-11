import assert from "node:assert/strict";
import { test } from "node:test";
import { Arrivals } from "../src/engine/arrivals.ts";
import { BACKGROUND_CONTEXT, type Context } from "../src/lib/chord.ts";
import { portLink } from "../src/link/port-link.ts";
import { fakePortPair } from "./support/fake-port.ts";

const link = () => portLink(fakePortPair()[0]);

test("a failed summon rejects at once and leaves no timer or waiter behind", async () => {
	const arrivals = new Arrivals<number>();
	await assert.rejects(arrivals.obtain(1, 20, BACKGROUND_CONTEXT, async () => { throw new Error("no tab"); }), /no tab/);
	// The would-be timeout must not surface as an unhandled rejection; a later port is kept for the next consumer.
	await new Promise((resolve) => setTimeout(resolve, 40));
	const late = link();
	arrivals.arrive(1, late);
	assert.equal(await arrivals.obtain(1, 20, BACKGROUND_CONTEXT, async () => assert.fail("not summoned again")), late);
});

test("abort rejects the wait and removes its waiter", async () => {
	const arrivals = new Arrivals<number>();
	const controller = new AbortController();
	const context = { ...BACKGROUND_CONTEXT, abortSignal: controller.signal } as Context;
	const waiting = arrivals.obtain(1, 10_000, context, async () => undefined);
	controller.abort(new Error("cancelled"));
	await assert.rejects(waiting, /cancelled/);
	const next = link();
	arrivals.arrive(1, next);
	assert.equal(await arrivals.obtain(1, 20, BACKGROUND_CONTEXT, async () => undefined), next, "the arrival was not handed to the aborted waiter");
});

test("a port arriving during the wait resolves it; a timeout rejects", async () => {
	const arrivals = new Arrivals<number>();
	const arriving = link();
	assert.equal(await arrivals.obtain(1, 1_000, BACKGROUND_CONTEXT, async () => arrivals.arrive(1, arriving)), arriving);
	await assert.rejects(arrivals.obtain(2, 10, BACKGROUND_CONTEXT, async () => undefined), /No port for 2 within 10 ms/);
});
