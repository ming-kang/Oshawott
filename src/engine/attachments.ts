import { type Harness, type InputEntry, type Tx, type UserInput } from "@earendil-works/pi-durable";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AttachmentInput, ModelRef } from "../contracts/chat.ts";
import {
	ATTACHMENTS_DIR, cleanFileName, composeUserContent, isImageAttachment, MAX_ATTACHMENTS, MAX_CHAT_FILE_BYTES,
	MAX_MESSAGE_ATTACHMENT_BYTES, type StoredAttachment, userEntry, userInput, validateAttachmentBatch,
} from "../lib/attachments.ts";
import { toBase64 } from "../lib/base64.ts";
import { ChordError, type Context } from "../lib/chord.ts";
import { AttachmentDeletesDoc } from "./docs.ts";
import type { FileBackend } from "./files.ts";
import { resolvePath, WORKSPACE } from "./files.ts";
import type { EngineServices } from "./facet.ts";

export type PreparedAttachment = StoredAttachment & { created: boolean };

function invalid(error: unknown): never {
	throw new ChordError({ code: "invalid", reason: "args", message: error instanceof Error ? error.message : String(error) });
}
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);

export function safeAttachmentPath(path: string): string {
	if (resolvePath(WORKSPACE, path) !== path || !path.startsWith(`${ATTACHMENTS_DIR}/`) || path.length <= ATTACHMENTS_DIR.length + 1) {
		throw new ChordError({ code: "forbidden", message: `Not an attachment of this chat: ${path}` });
	}
	return path;
}

export async function storeAttachments(
	files: FileBackend, chat: number, inputs: readonly AttachmentInput[], now: () => number,
	scope: string, credit: readonly string[] = [],
): Promise<PreparedAttachment[]> {
	if (!inputs.length) return [];
	let validated: ReturnType<typeof validateAttachmentBatch>;
	try {
		validated = validateAttachmentBatch(inputs);
	} catch (error) {
		return invalid(error);
	}
	try {
		return await files.transact(chat, "readwrite", async (tx) => {
			const directory = await tx.get(ATTACHMENTS_DIR);
			if (directory && directory.kind !== "directory") throw new Error(`${ATTACHMENTS_DIR} is not a directory.`);
			let used = (await tx.below(WORKSPACE)).reduce((sum, [, entry]) => sum + (entry.kind === "file" ? entry.size : 0), 0);
			const paths = new Set<string>();
			const owner = safeId(scope);
			if (!owner) throw new Error("Every attachment batch needs a valid request ID.");
			const planned = inputs.map((input, index) => {
				const id = safeId(input.id);
				if (!id) throw new Error("Every attachment needs a valid ID.");
				const path = safeAttachmentPath(`${ATTACHMENTS_DIR}/${owner}-${id}-${cleanFileName(input.name)}`);
				if (paths.has(path)) throw new Error("Attachment IDs must be unique within a message.");
				paths.add(path);
				return { input, path, metadata: validated[index]! };
			});
			for (const path of new Set(credit)) {
				safeAttachmentPath(path);
				if (paths.has(path)) continue;
				const entry = await tx.get(path);
				if (entry?.kind === "file") used -= entry.size;
			}
			const prepared: PreparedAttachment[] = [];
			for (const { input, path, metadata } of planned) {
				const previous = await tx.get(path);
				if (previous?.kind === "directory") throw new Error(`${path} is a directory.`);
				if (previous) {
					const old = await tx.data(path);
					const identical = old?.length === input.data.length && input.data.every((byte, index) => old[index] === byte);
					if (!identical) throw new Error(`${input.name}: this attachment ID was already used with different bytes.`);
				}
				used += input.data.length - (previous?.size ?? 0);
				if (used > MAX_CHAT_FILE_BYTES) throw new Error("This chat's 100 MiB file quota is exhausted. Delete files or start a new chat.");
				prepared.push({ ...metadata, path, id: input.id, data: input.data, created: previous === undefined });
			}
			tx.put(ATTACHMENTS_DIR, { kind: "directory", size: 0, mtimeMs: now() });
			for (const item of prepared) tx.put(item.path, { kind: "file", size: item.data.length, mtimeMs: now() }, item.data);
			return prepared;
		});
	} catch (error) {
		if (error instanceof ChordError) throw error;
		return invalid(error);
	}
}

export async function discardAttachments(files: FileBackend, chat: number, paths: readonly string[]): Promise<void> {
	if (!paths.length) return;
	for (const path of paths) safeAttachmentPath(path);
	await files.transact(chat, "readwrite", async (tx) => {
		for (const path of paths) tx.delete(path);
	});
}

export const rollbackAttachments = (files: FileBackend, chat: number, prepared: readonly PreparedAttachment[]) =>
	discardAttachments(files, chat, prepared.filter((item) => item.created).map((item) => item.path)).catch(() => undefined);

/**
 * Record, inside the commit that drops their last reference, attachment files to delete once it has committed. Callers
 * run `completeAttachmentDeletes` after the commit; an intent a crash interrupts is completed by the next Engine.
 */
export async function intendAttachmentDeletes(tx: Tx, chat: number, paths: readonly string[]): Promise<void> {
	const unique = [...new Set(paths)].map(safeAttachmentPath);
	if (!unique.length) return;
	(await tx.doc(AttachmentDeletesDoc)).pending.push({ id: crypto.randomUUID(), chat, paths: unique });
}

/** Delete every recorded intent's files, clearing each intent once its files are gone. Idempotent and retryable. */
export async function completeAttachmentDeletes(harness: Harness, files: FileBackend, context: Context, onError: (error: unknown) => void) {
	for (const intent of (await harness.snapshot(AttachmentDeletesDoc, context))?.pending ?? []) {
		try {
			await discardAttachments(files, intent.chat, intent.paths);
			await harness.commit(async (tx) => {
				const doc = await tx.doc(AttachmentDeletesDoc);
				doc.pending = doc.pending.filter((item) => item.id !== intent.id);
			}, context);
		} catch (error) {
			onError(error);
		}
	}
}

const imageOf = (item: StoredAttachment): ImageContent => ({ type: "image", data: toBase64(item.data), mimeType: item.mimeType });

export type QueuedInput = { content: UserInput; entry?: InputEntry };

/** The model content and entry of a new input: the entry carries the attachments, the content projects them. */
export function inputForSend(text: string, attachments: readonly StoredAttachment[]): QueuedInput {
	const entry = userEntry(text, attachments);
	return { content: composeUserContent(text, attachments, attachments.filter(isImageAttachment).map(imageOf)), ...(entry ? { entry } : {}) };
}

export function inputForUpdate(
	input: QueuedInput,
	text: string | undefined,
	added: readonly StoredAttachment[],
	removed: ReadonlySet<string>,
): QueuedInput {
	const current = userInput(input.entry, input.content);
	for (const path of removed) {
		safeAttachmentPath(path);
		if (!current.attachments.some((item) => item.path === path)) invalid(`Attachment ${path} does not belong to this queued message.`);
	}
	const addedPaths = new Set(added.map((item) => item.path));
	const refs = [...current.attachments.filter((item) => !removed.has(item.path) && !addedPaths.has(item.path)), ...added];
	if (refs.length > MAX_ATTACHMENTS) invalid(`A message can have at most ${MAX_ATTACHMENTS} attachments.`);
	if (refs.reduce((sum, item) => sum + item.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
		invalid("Attachments in one message are limited to 24 MiB in total.");
	}
	// Image blocks follow the entry's image attachments in order; any beyond them (image-only input without an entry) stay.
	const oldImages = typeof input.content === "string" ? [] : input.content.filter((block): block is ImageContent => block.type === "image");
	const currentImages = current.attachments.filter(isImageAttachment);
	const byPath = new Map(currentImages.map((item, index) => [item.path, oldImages[index]] as const));
	const addedByPath = new Map(added.map((item) => [item.path, imageOf(item)] as const));
	const images = refs.filter(isImageAttachment).map((item) => {
		const image = addedByPath.get(item.path) ?? byPath.get(item.path);
		if (!image) invalid(`The image content for ${item.path} is unavailable.`);
		return image;
	});
	images.push(...oldImages.slice(currentImages.length));
	const nextText = text ?? current.text;
	if (!nextText.trim() && !refs.length && !images.length) invalid("The message cannot be empty.");
	return { content: composeUserContent(nextText, refs, images), entry: userEntry(nextText, refs) };
}

export function requireContentVision(services: EngineServices, ref: ModelRef | null | undefined, content: UserInput) {
	if (typeof content === "string" || !content.some((block) => block.type === "image")) return;
	if (!ref) invalid("This message contains an image. Choose a vision-capable model first.");
	const model = services.models.getModel(ref.provider, ref.modelId);
	if (!model) invalid(`The selected model ${ref.modelId} is unavailable. Choose a vision-capable model before sending.`);
	if (!model.input.includes("image")) invalid(`${model.name ?? model.id} cannot process images. Choose a vision-capable model before sending.`);
}

/** Attachment paths an input's entry owns. */
export const attachmentPaths = (input: QueuedInput) => userInput(input.entry, input.content).attachments.map((item) => item.path);
