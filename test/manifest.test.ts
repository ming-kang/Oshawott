import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { manifestFor, MODEL_ORIGINS } from "../src/manifest.ts";

/** Chromium derives an extension's ID from its public key; without one, an unpacked copy's ID follows its folder. */
const chromiumId = (key: string) => [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)]
	.map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))).join("");

test("every build keeps the extension ID its stored chats and credentials belong to", () => {
	for (const options of [{}, { dev: true }]) {
		const chromium = manifestFor("chromium", "1.2.3", options);
		assert.equal(chromiumId(String(chromium.key)), "nbemmciikpdicdifcdfapndnmmjcmdaa");
		const firefox = manifestFor("firefox", "1.2.3", options);
		assert.equal("key" in firefox, false);
		assert.partialDeepStrictEqual(firefox, { browser_specific_settings: { gecko: { id: "oshawott@astralyn" } } });
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
