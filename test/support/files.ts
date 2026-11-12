import assert from "node:assert/strict";
import { test } from "node:test";
import { createEnvConformance, type EnvConformanceProvider } from "@earendil-works/pi-durable/testing";

/** Durable's `ExecutionEnv` cases a chat's files must pass; watching, commands and links are not part of them. */
export function conformance(prefix: string, withEnv: EnvConformanceProvider): void {
	for (const conformance of createEnvConformance({
		assertions: {
			ok: (value, message) => message === undefined ? assert.ok(value) : assert.ok(value, message),
			strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
			deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
			partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
			greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
			rejects: (operation, includes) => assert.rejects(operation, (error: Error) => error.message.includes(includes)),
		},
		withEnv,
		symlinks: false,
		listFiles: true,
	})) {
		if (/^watch|exec|git ignores|symbolic/.test(conformance.name)) continue;
		test(`${prefix}: ${conformance.name}`, () => conformance.run());
	}
}
