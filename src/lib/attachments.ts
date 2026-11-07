import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";

export const ATTACHMENTS_DIR = "/workspace/attachments";
export const MAX_ATTACHMENTS = 8;
export const MAX_TEXT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Pi's inline-image ceiling is 4.5 MiB after base64 encoding. */
export const MAX_IMAGE_ATTACHMENT_BYTES = Math.floor(4.5 * 1024 * 1024) / 4 * 3;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 24 * 1024 * 1024;
export const MAX_CHAT_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 2000;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type ImageMimeType = typeof IMAGE_MIME_TYPES[number];
export type AttachmentInput = { id: string; name: string; mimeType: string; data: Uint8Array };
export type AttachmentRef = {
	path: string;
	name: string;
	mimeType: string;
	size: number;
	lines?: number;
	width?: number;
	height?: number;
};
export type StoredAttachment = AttachmentRef & { id: string; data: Uint8Array };
export type UserContent = UserMessage["content"];

const TEXT_EXTENSIONS = new Set([
	"txt", "text", "log", "md", "markdown", "mdx", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "html", "htm", "css",
	"js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "py", "rb", "go", "rs", "java", "c", "h", "cc", "cpp", "hpp",
	"cs", "swift", "kt", "kts", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "yaml", "yml", "toml", "ini", "cfg",
	"conf", "env", "vue", "svelte", "astro", "graphql", "gql", "proto", "diff", "patch",
]);
const TEXT_MIME_TYPES = new Set([
	"application/json", "application/ld+json", "application/ndjson", "application/xml", "application/xhtml+xml",
	"application/javascript", "application/x-javascript", "application/typescript", "application/x-sh", "application/x-httpd-php",
	"application/sql", "application/toml", "application/yaml", "application/x-yaml", "application/csv", "application/graphql",
]);
const IMAGE_EXTENSIONS: Record<string, ImageMimeType> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

export function cleanFileName(name: string): string {
	const cleaned = name.normalize("NFKC").replace(/[\\/<>:"\u0000-\u001f\u007f]/g, "-").replace(/^\.+/, "").trim();
	return (cleaned || "attachment").slice(0, 160);
}

const extensionOf = (name: string) => name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
const starts = (data: Uint8Array, values: readonly number[]) => values.every((value, index) => data[index] === value);
const ascii = (data: Uint8Array, offset: number, text: string) => [...text].every((char, index) => data[offset + index] === char.charCodeAt(0));
const u16le = (data: Uint8Array, at: number) => (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
const u16be = (data: Uint8Array, at: number) => ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0);
const u32le = (data: Uint8Array, at: number) => u16le(data, at) + u16le(data, at + 2) * 0x10000;
const u32be = (data: Uint8Array, at: number) => u16be(data, at) * 0x10000 + u16be(data, at + 2);

/** Sniff the supported inline formats. The declared type alone is never trusted. */
export function sniffImage(data: Uint8Array): ImageMimeType | undefined {
	if (starts(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && data.length >= 24 && ascii(data, 12, "IHDR")) return "image/png";
	if (starts(data, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (ascii(data, 0, "GIF87a") || ascii(data, 0, "GIF89a")) return "image/gif";
	if (ascii(data, 0, "RIFF") && ascii(data, 8, "WEBP")) return "image/webp";
	return undefined;
}

function jpegScan(data: Uint8Array, start: number): boolean {
	let entropy = false;
	for (let offset = start; offset < data.length;) {
		if (data[offset] !== 0xff) {
			entropy = true;
			offset++;
			continue;
		}
		while (data[offset] === 0xff) offset++;
		const marker = data[offset++];
		if (marker === 0x00) {
			entropy = true;
			continue;
		}
		if (marker !== undefined && marker >= 0xd0 && marker <= 0xd7) continue;
		// Any other marker ends this scan. In particular, EOI itself is not image data.
		return marker === 0xd9 && entropy;
	}
	return false;
}

function completeJpeg(data: Uint8Array): boolean {
	if (data.length < 6 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) return false;
	let offset = 2;
	while (offset + 4 <= data.length - 2) {
		if (data[offset] !== 0xff) return false;
		while (data[offset] === 0xff) offset++;
		const marker = data[offset++];
		if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
		const length = u16be(data, offset);
		if (length < 2 || offset + length > data.length - 2) return false;
		// Start of Scan must contain entropy-coded bytes, not merely a following marker.
		if (marker === 0xda) return jpegScan(data, offset + length);
		offset += length;
	}
	return false;
}

function gifBlocks(data: Uint8Array, start: number): { offset: number; bytes: boolean } | undefined {
	let offset = start;
	let bytes = false;
	while (offset < data.length) {
		const length = data[offset++]!;
		if (length === 0) return { offset, bytes };
		bytes = true;
		offset += length;
		if (offset > data.length) return undefined;
	}
	return undefined;
}

function completeGif(data: Uint8Array): boolean {
	if (data.length < 15) return false;
	const packed = data[10]!;
	let offset = 13 + (packed & 0x80 ? 3 * (1 << ((packed & 7) + 1)) : 0);
	while (offset < data.length) {
		const marker = data[offset];
		if (marker === 0x3b) return false;
		if (marker === 0x21) {
			const blocks = gifBlocks(data, offset + 2);
			if (!blocks) return false;
			offset = blocks.offset;
			continue;
		}
		if (marker !== 0x2c || offset + 10 > data.length) return false;
		const local = data[offset + 9]!;
		offset += 10 + (local & 0x80 ? 3 * (1 << ((local & 7) + 1)) : 0);
		if (offset >= data.length) return false;
		offset++; // LZW minimum code size.
		const blocks = gifBlocks(data, offset);
		return Boolean(blocks?.bytes && blocks.offset < data.length && data[blocks.offset] === 0x3b);
	}
	return false;
}

function completeWebp(data: Uint8Array): boolean {
	if (data.length < 20) return false;
	const end = Math.min(data.length, u32le(data, 4) + 8);
	let offset = 12;
	while (offset + 8 <= end) {
		const size = u32le(data, offset + 4);
		const next = offset + 8 + size + (size & 1);
		if (next > end || next <= offset) return false;
		if ((ascii(data, offset, "VP8 ") || ascii(data, offset, "VP8L")) && size > 0) return true;
		if (ascii(data, offset, "ANMF") && size >= 24 && (ascii(data, offset + 24, "VP8 ") || ascii(data, offset + 24, "VP8L"))) {
			const frameBytes = u32le(data, offset + 28);
			if (frameBytes > 0 && offset + 32 + frameBytes <= offset + 8 + size) return true;
		}
		offset = next;
	}
	return false;
}

function completeImage(data: Uint8Array, mimeType: ImageMimeType): boolean {
	if (mimeType === "image/jpeg") return completeJpeg(data);
	if (mimeType === "image/gif") return completeGif(data);
	if (mimeType === "image/webp") return completeWebp(data);
	let offset = 8;
	let pixels = false;
	while (offset + 12 <= data.length) {
		const length = u32be(data, offset);
		const next = offset + length + 12;
		if (next <= offset || next > data.length) return false;
		if (ascii(data, offset + 4, "IDAT") && length > 0) pixels = true;
		if (ascii(data, offset + 4, "IEND")) return pixels && length === 0;
		offset = next;
	}
	return false;
}

export function imageDimensions(data: Uint8Array, mimeType: ImageMimeType): { width: number; height: number } | undefined {
	if (mimeType === "image/png") return { width: u32be(data, 16), height: u32be(data, 20) };
	if (mimeType === "image/gif") return data.length < 10 ? undefined : { width: u16le(data, 6), height: u16le(data, 8) };
	if (mimeType === "image/webp") {
		if (data.length < 30) return undefined;
		if (ascii(data, 12, "VP8 ")) return { width: u16le(data, 26) & 0x3fff, height: u16le(data, 28) & 0x3fff };
		if (ascii(data, 12, "VP8L")) {
			const bits = u32le(data, 21);
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		if (ascii(data, 12, "VP8X")) {
			const dimension = (at: number) => u16le(data, at) + ((data[at + 2] ?? 0) << 16) + 1;
			return { width: dimension(24), height: dimension(27) };
		}
		return undefined;
	}
	for (let offset = 2; offset + 9 <= data.length;) {
		if (data[offset] !== 0xff) return undefined;
		const marker = data[offset + 1]!;
		if (marker === 0xff) { offset++; continue; }
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { width: u16be(data, offset + 7), height: u16be(data, offset + 5) };
		}
		offset += 2 + u16be(data, offset + 2);
	}
	return undefined;
}

export function validateAttachment(input: Pick<AttachmentInput, "name" | "mimeType" | "data">): Omit<AttachmentRef, "path"> {
	const name = cleanFileName(input.name);
	const declared = input.mimeType.toLowerCase().split(";", 1)[0]!.trim();
	const sniffed = sniffImage(input.data);
	const extension = extensionOf(name);
	const imageExtension = IMAGE_EXTENSIONS[extension];
	if (sniffed || declared.startsWith("image/") || imageExtension) {
		if (!sniffed) throw new Error(`${name}: the image is not a valid PNG, JPEG, WebP or GIF.`);
		if (declared && declared !== sniffed && declared !== "application/octet-stream") {
			throw new Error(`${name}: declared type ${declared} does not match ${sniffed}.`);
		}
		if (imageExtension && imageExtension !== sniffed) throw new Error(`${name}: its extension does not match ${sniffed}.`);
		if (!completeImage(input.data, sniffed)) throw new Error(`${name}: the ${sniffed} file is truncated or incomplete.`);
		if (input.data.length > MAX_IMAGE_ATTACHMENT_BYTES) {
			throw new Error(`${name}: images are limited to 3.375 MiB each so their inline form stays below 4.5 MiB.`);
		}
		const dimensions = imageDimensions(input.data, sniffed);
		if (!dimensions || dimensions.width < 1 || dimensions.height < 1) throw new Error(`${name}: its image dimensions cannot be read.`);
		if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
			throw new Error(`${name}: images are limited to ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} pixels.`);
		}
		return { name, mimeType: sniffed, size: input.data.length, ...dimensions };
	}
	const generic = !declared || declared === "application/octet-stream";
	const declaredText = declared.startsWith("text/") || TEXT_MIME_TYPES.has(declared);
	if (!generic && !declaredText) throw new Error(`${name}: unsupported MIME type ${declared}.`);
	if (!declaredText && !TEXT_EXTENSIONS.has(extension)) {
		throw new Error(`${name}: unsupported file type. Choose UTF-8 text, code, JSON, CSV, Markdown or a supported image.`);
	}
	if (input.data.length > MAX_TEXT_ATTACHMENT_BYTES) throw new Error(`${name}: text attachments are limited to 5 MiB each.`);
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.data);
	} catch {
		throw new Error(`${name}: text attachments must be valid UTF-8.`);
	}
	return { name, mimeType: declaredText ? declared : "text/plain", size: input.data.length, lines: decoded.length ? decoded.split("\n").length : 0 };
}

export function validateAttachmentBatch(inputs: readonly Pick<AttachmentInput, "name" | "mimeType" | "data">[]) {
	if (inputs.length > MAX_ATTACHMENTS) throw new Error(`A message can have at most ${MAX_ATTACHMENTS} attachments.`);
	const bytes = inputs.reduce((sum, input) => sum + input.data.length, 0);
	if (bytes > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error("Attachments in one message are limited to 24 MiB in total.");
	return inputs.map(validateAttachment);
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const number = (value: string | undefined) => value === undefined ? undefined : Number(value);

/** Model-readable metadata only: text bodies stay in the file area. */
export function attachmentMetadata(attachments: readonly AttachmentRef[]): string {
	if (!attachments.length) return "";
	const lines = attachments.map((item) => {
		const attrs = [
			["path", item.path], ["name", item.name], ["mimeType", item.mimeType], ["size", String(item.size)],
			...(item.lines !== undefined ? [["lines", String(item.lines)]] : []),
			...(item.width !== undefined ? [["width", String(item.width)], ["height", String(item.height)]] : []),
		] as const;
		return `<attachment ${attrs.map(([key, value]) => `${key}="${escape(value)}"`).join(" ")} />`;
	});
	return `<oshawott-attachments>\nThe user's attachments are saved in this chat. Read text or code from its path with read or read_text; do not ask the user to paste it. Image content is attached natively and the same bytes are available at its path.\n${lines.join("\n")}\n</oshawott-attachments>`;
}

const SECTION = /<oshawott-attachments>[\s\S]*?<\/oshawott-attachments>/g;
const ATTRIBUTE = /(path|name|mimeType|size|lines|width|height)="([^"]*)"/g;

export function attachmentsInText(text: string): AttachmentRef[] {
	const found: AttachmentRef[] = [];
	for (const section of text.matchAll(SECTION)) {
		for (const line of section[0].matchAll(/<attachment\s+([^>]+)\/>/g)) {
			const attrs: Record<string, string> = {};
			for (const match of line[1]!.matchAll(ATTRIBUTE)) attrs[match[1]!] = unescape(match[2]!);
			const size = number(attrs.size);
			if (!attrs.path?.startsWith(`${ATTACHMENTS_DIR}/`) || !attrs.name || !attrs.mimeType || !Number.isSafeInteger(size) || size! < 0) continue;
			found.push({
				path: attrs.path, name: attrs.name, mimeType: attrs.mimeType, size: size!,
				...(attrs.lines !== undefined ? { lines: number(attrs.lines) } : {}),
				...(attrs.width !== undefined ? { width: number(attrs.width), height: number(attrs.height) } : {}),
			});
		}
	}
	return found;
}

const metadataBlock = (content: UserContent): TextContent | undefined => {
	if (typeof content === "string") return undefined;
	const block = content.filter((item) => item.type === "text").at(-1);
	const text = block?.text.trim();
	return text?.startsWith("<oshawott-attachments>") && text.endsWith("</oshawott-attachments>") ? block : undefined;
};
/** Only our dedicated final text block is authoritative; literal markup in ordinary prompt text stays ordinary text. */
export const attachmentRefs = (content: UserContent): AttachmentRef[] => attachmentsInText(metadataBlock(content)?.text ?? "");
export const editableText = (content: UserContent): string => {
	if (typeof content === "string") return content;
	const metadata = metadataBlock(content);
	return content.filter((block) => block.type === "text").map((block) => block === metadata ? "" : block.text).join("");
};

/** Rebuild a user message without merging its metadata into editable text or dropping image blocks. */
export function composeUserContent(text: string, attachments: readonly AttachmentRef[], images: readonly ImageContent[] = []): UserContent {
	const blocks: Exclude<UserContent, string> = [];
	if (text || (!attachments.length && !images.length)) blocks.push({ type: "text", text });
	if (attachments.length) blocks.push({ type: "text", text: attachmentMetadata(attachments) });
	blocks.push(...images);
	if (!attachments.length && !images.length) return text;
	return blocks;
}

export const isImageAttachment = (item: Pick<AttachmentRef, "mimeType">) => IMAGE_MIME_TYPES.includes(item.mimeType as ImageMimeType);
