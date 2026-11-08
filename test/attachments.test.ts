import assert from "node:assert/strict";
import { test } from "node:test";
import {
	attachmentMetadata, cleanFileName, composeUserContent, imageDimensions, isImageAttachment, MAX_ATTACHMENTS,
	MAX_CHAT_FILE_BYTES, sniffImage, USER_ENTRY, userInput, validateAttachment, validateAttachmentBatch,
} from "../src/lib/attachments.ts";
import { inputForSend, inputForUpdate, type QueuedInput, safeAttachmentPath, storeAttachments } from "../src/engine/attachments.ts";
import { MemoryFileBackend } from "../src/engine/files.ts";
import { fromBase64 } from "../src/lib/base64.ts";

const PNG = fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
const encoder = new TextEncoder();
const input = (id: string, name: string, mimeType: string, data: Uint8Array) => ({ id, name, mimeType, data });
const of = (input: QueuedInput) => userInput(input.entry, input.content);
const imagesOf = (input: QueuedInput) => typeof input.content === "string" ? 0 : input.content.filter((block) => block.type === "image").length;
const stored = (id: string, name: string, mimeType: string, data: Uint8Array) => {
	const metadata = validateAttachment({ name, mimeType, data });
	return { ...metadata, id, path: `/workspace/attachments/${id}-${metadata.name}`, data };
};

test("text attachments retain metadata but never inline their body", () => {
	const body = "first line\n第二行\nthird line";
	const item = stored("notes", "notes.md", "text/markdown", encoder.encode(body));
	assert.equal(item.lines, 3);
	const sent = inputForSend("Summarize", [item]);
	assert.equal(sent.entry?.kind, USER_ENTRY);
	assert.equal(of(sent).text, "Summarize");
	assert.deepEqual(of(sent).attachments, [{ path: item.path, name: item.name, mimeType: item.mimeType, size: item.size, lines: 3 }]);
	assert.ok(!JSON.stringify(sent).includes(body));
	assert.ok(attachmentMetadata([item]).includes(item.path));
	assert.deepEqual(composeUserContent("before", [item]), [{ type: "text", text: "before" }, { type: "text", text: attachmentMetadata([item]) }]);
	assert.equal(inputForSend("Plain", []).entry, undefined, "an input without attachments stays pi.user");
});

test("image sniffing, dimensions and MIME mismatches are validated", () => {
	assert.equal(sniffImage(PNG), "image/png");
	assert.deepEqual(imageDimensions(PNG, "image/png"), { width: 1, height: 1 });
	const item = validateAttachment({ name: "pixel.png", mimeType: "image/png", data: PNG });
	assert.equal(isImageAttachment(item), true);
	assert.equal(item.width, 1);
	assert.throws(() => validateAttachment({ name: "pixel.png", mimeType: "image/jpeg", data: PNG }), /does not match/);
	assert.throws(() => validateAttachment({ name: "fake.png", mimeType: "image/png", data: encoder.encode("not an image") }), /not a valid/);
	assert.throws(() => validateAttachment({ name: "header.png", mimeType: "image/png", data: PNG.slice(0, 24) }), /truncated or incomplete/);
	const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 1, 1, 1, 17, 0, 0xff, 0xd9]);
	assert.throws(() => validateAttachment({ name: "empty.jpg", mimeType: "image/jpeg", data: jpeg }), /truncated or incomplete/);
	const gif = new Uint8Array([...encoder.encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b]);
	assert.throws(() => validateAttachment({ name: "empty.gif", mimeType: "image/gif", data: gif }), /truncated or incomplete/);
	const webp = new Uint8Array(30);
	webp.set(encoder.encode("RIFF"), 0); new DataView(webp.buffer).setUint32(4, 22, true);
	webp.set(encoder.encode("WEBP"), 8); webp.set(encoder.encode("VP8X"), 12); new DataView(webp.buffer).setUint32(16, 10, true);
	assert.throws(() => validateAttachment({ name: "empty.webp", mimeType: "image/webp", data: webp }), /truncated or incomplete/);
	const scanless = Uint8Array.from(Buffer.from("ffd8ffc0000b080001000101011100ffda0008010100003f00ffd9ffd9", "hex"));
	assert.throws(() => validateAttachment({ name: "no-scan.jpg", mimeType: "image/jpeg", data: scanless }), /truncated or incomplete/);
	const animated = new Uint8Array(62);
	animated.set(webp.subarray(0, 30), 0);
	new DataView(animated.buffer).setUint32(4, 54, true);
	animated.set(encoder.encode("ANMF"), 30); new DataView(animated.buffer).setUint32(34, 24, true);
	animated.set(encoder.encode("VP8L"), 54);
	assert.throws(() => validateAttachment({ name: "empty-frame.webp", mimeType: "image/webp", data: animated }), /truncated or incomplete/);
	const validGif = fromBase64("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
	assert.equal(validateAttachment({ name: "pixel.gif", mimeType: "image/gif", data: validGif }).width, 1);
	// Two frames: header and global color table, then the extension and image blocks twice, then the trailer.
	const header = 13 + 3 * (1 << ((validGif[10]! & 7) + 1));
	const frame = validGif.subarray(header, validGif.length - 1);
	const animatedGif = new Uint8Array([...validGif.subarray(0, header), ...frame, ...frame, 0x3b]);
	assert.equal(validateAttachment({ name: "animated.gif", mimeType: "image/gif", data: animatedGif }).width, 1);
	assert.throws(() => validateAttachment({ name: "cut.gif", mimeType: "image/gif", data: animatedGif.subarray(0, -1) }), /truncated or incomplete/);
	const oversized = PNG.slice();
	new DataView(oversized.buffer).setUint32(16, 2001);
	assert.throws(() => validateAttachment({ name: "large.png", mimeType: "image/png", data: oversized }), /2000×2000/);
});

test("unsupported binary, invalid UTF-8 and excess attachment counts have actionable errors", () => {
	assert.throws(() => validateAttachment({ name: "archive.zip", mimeType: "application/zip", data: new Uint8Array([1, 2]) }), /unsupported MIME type/);
	assert.throws(() => validateAttachment({ name: "fake.txt", mimeType: "application/zip", data: encoder.encode("text") }), /unsupported MIME type/);
	assert.throws(() => validateAttachment({ name: "bad.txt", mimeType: "text/plain", data: new Uint8Array([0xc3, 0x28]) }), /valid UTF-8/);
	const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => input(String(index), `${index}.txt`, "text/plain", encoder.encode("x")));
	assert.throws(() => validateAttachmentBatch(files), /at most 8/);
});

test("file names are confined and attachment paths reject traversal", () => {
	const cleaned = cleanFileName("../../<secret>.txt");
	assert.ok(!cleaned.startsWith(".") && !/[\\/<>]/.test(cleaned));
	assert.throws(() => safeAttachmentPath("/workspace/other/file.txt"), /Not an attachment/);
	assert.throws(() => safeAttachmentPath("/workspace/attachments/../other.txt"), /Not an attachment/);
	assert.throws(() => safeAttachmentPath("attachments/file.txt"), /Not an attachment/);
	const genuine = stored("genuine", "real.txt", "text/plain", encoder.encode("real"));
	const markup = attachmentMetadata([genuine]);
	assert.deepEqual(userInput(undefined, markup), { text: markup, attachments: [] }, "prompt text is never attachment ownership metadata");
	assert.deepEqual(of({ content: composeUserContent(markup, []) }).attachments, []);
});

test("queued edits preserve image blocks and metadata, and removals are explicit", () => {
	const first = stored("first", "first.png", "image/png", PNG);
	const second = stored("second", "second.png", "image/png", PNG);
	const original = inputForSend("Original", [first, second]);
	const edited = inputForUpdate(original, "Edited", [], new Set());
	assert.equal(of(edited).text, "Edited");
	assert.equal(of(edited).attachments.length, 2);
	assert.equal(imagesOf(edited), 2);
	const added = stored("added", "added.txt", "text/plain", encoder.encode("complete text"));
	const removed = inputForUpdate(edited, "", [added], new Set([first.path]));
	assert.deepEqual(of(removed).attachments.map((item) => item.path), [second.path, added.path]);
	assert.equal(imagesOf(removed), 1);
	assert.equal(of(removed).text, "");
	assert.throws(() => inputForUpdate(original, "bad", [], new Set(["/workspace/attachments/missing.txt"])), /does not belong/);
	const plain = inputForUpdate(removed, "Only text", [], new Set([second.path, added.path]));
	assert.deepEqual(plain, { content: "Only text", entry: undefined }, "removing every attachment returns to a pi.user input");
	const legacy = inputForUpdate({ content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }, "Caption", [], new Set());
	assert.equal(imagesOf(legacy), 1, "image blocks without attachment metadata are kept");
});

test("attachment storage enforces message quotas and isolates chats", async () => {
	const files = new MemoryFileBackend();
	const big = new Uint8Array(5 * 1024 * 1024);
	const inputs = Array.from({ length: 8 }, (_, index) => input(`file-${index}`, `${index}.txt`, "text/plain", big));
	await assert.rejects(storeAttachments(files, 1, inputs, () => 1, "batch"), /24 MiB/);
	assert.deepEqual(await files.transact(1, "readonly", async (tx) => tx.below("/workspace")), []);
	const small = input("one", "one.txt", "text/plain", encoder.encode("one"));
	const [saved] = await storeAttachments(files, 1, [small], () => 1, "request");
	assert.equal(saved?.created, true);
	assert.equal((await storeAttachments(files, 2, [small], () => 1, "request"))[0]?.created, true, "another chat has its own namespace");
	assert.equal((await storeAttachments(files, 1, [small], () => 1, "request"))[0]?.created, false, "a retry replaces its deterministic path");
	await assert.rejects(storeAttachments(files, 1, [input("one", "one.txt", "text/plain", encoder.encode("changed"))], () => 1, "request"), /different bytes/);
	assert.deepEqual(await files.transact(1, "readonly", async (tx) => tx.data(saved!.path)), encoder.encode("one"));
	await files.transact(3, "readwrite", async (tx) => {
		// Metadata is sufficient for quota accounting; avoid allocating another 100 MiB in this test.
		tx.put("/workspace/full", { kind: "file", size: MAX_CHAT_FILE_BYTES, mtimeMs: 1 }, new Uint8Array());
	});
	await assert.rejects(storeAttachments(files, 3, [small], () => 1, "request"), /100 MiB file quota/);
	await files.transact(4, "readwrite", async (tx) => {
		tx.put("/workspace/full", { kind: "file", size: MAX_CHAT_FILE_BYTES - 3, mtimeMs: 1 }, new Uint8Array());
		tx.put("/workspace/attachments/old.txt", { kind: "file", size: 3, mtimeMs: 1 }, new Uint8Array(3));
	});
	await storeAttachments(files, 4, [small], () => 1, "replacement", ["/workspace/attachments/old.txt"]);
});
