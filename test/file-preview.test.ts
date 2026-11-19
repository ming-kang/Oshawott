import assert from "node:assert/strict";
import { test } from "node:test";
import { previewKind } from "../src/panel/file-preview.ts";

const encode = (text: string) => new TextEncoder().encode(text);

test("image extensions are images with their mime, including svg", () => {
	assert.deepEqual(previewKind("shots/pixel.png", encode("x")), { type: "image", mime: "image/png" });
	assert.deepEqual(previewKind("logo.svg", encode("<svg/>")), { type: "image", mime: "image/svg+xml" });
});

test("known text extensions are text with a bundled language when one exists", () => {
	assert.deepEqual(previewKind("items.json", encode("{}")), { type: "text", language: "json" });
	assert.deepEqual(previewKind("notes.md", encode("# hi")), { type: "text", language: undefined });
});

test("an unknown extension sniffs UTF-8 without NUL as text", () => {
	assert.deepEqual(previewKind("dump.bin", encode("plain text")), { type: "text" });
	assert.deepEqual(previewKind("no-extension", encode("こんにちは")), { type: "text" });
});

test("a NUL inside the 8 KB window or invalid UTF-8 is binary", () => {
	assert.deepEqual(previewKind("archive.bin", new Uint8Array([0x50, 0x4b, 0x00, 0x01])), { type: "binary" });
	assert.deepEqual(previewKind("data.bin", new Uint8Array([0xff, 0xfe, 0xfd])), { type: "binary" });
});

test("a multi-byte character sliced by the 8 KB window still sniffs as text", () => {
	const bytes = new Uint8Array(8192).fill(0x61);
	bytes[8191] = 0xc3; // The lead byte of "é"; its continuation would land past the window.
	assert.deepEqual(previewKind("log.dat", bytes), { type: "text" });
});
