import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CHROMIUM_KEY, manifestFor, MODEL_ORIGINS } from "../src/manifest.ts";

test("the pinned Chromium public key produces the documented extension ID", () => {
	const hash = createHash("sha256").update(Buffer.from(CHROMIUM_KEY, "base64")).digest("hex");
	const id = [...hash.slice(0, 32)].map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))).join("");
	assert.equal(id, "nbemmciikpdicdifcdfapndnmmjcmdaa");
});

test("Chromium development and unpacked builds pin the ID", () => {
	for (const dev of [false, true]) {
		const manifest = manifestFor("chromium", "1.2.3", { dev });
		assert.equal(manifest.key, CHROMIUM_KEY);
		assert.equal(manifest.minimum_chrome_version, "120");
	}
});

test("Firefox has a stable gecko ID and never inherits the Chromium key", () => {
	for (const options of [{}, { dev: true }]) {
		const manifest = manifestFor("firefox", "1.2.3", options);
		assert.equal("key" in manifest, false);
		assert.deepEqual(manifest.browser_specific_settings, {
			gecko: { id: "oshawott@astralyn", strict_min_version: "128.0" },
		});
	}
});

test("only development builds request static all-sites access", () => {
	for (const target of ["chromium", "firefox"] as const) {
		const production = manifestFor(target, "1.2.3");
		assert.deepEqual(production.host_permissions, MODEL_ORIGINS);
		assert.deepEqual(production.optional_host_permissions, ["<all_urls>"]);
		const development = manifestFor(target, "1.2.3", { dev: true });
		assert.deepEqual(development.host_permissions, [...MODEL_ORIGINS, "<all_urls>"]);
	}
});
