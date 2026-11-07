import { InboxDoc, type ConversationId, type Harness, type UserInput } from "@earendil-works/pi-durable";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AttachmentInput, ModelRef } from "../contracts/chat.ts";
import {
	ATTACHMENTS_DIR, attachmentRefs, cleanFileName, composeUserContent, editableText, isImageAttachment,
	MAX_ATTACHMENTS, MAX_CHAT_FILE_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, type AttachmentRef, type StoredAttachment,
	validateAttachmentBatch,
} from "../lib/attachments.ts";
import { toBase64 } from "../lib/base64.ts";
import { ChordError, type Context } from "../lib/chord.ts";
import { RequestDoc, WorkspaceDoc } from "./docs.ts";
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

/** Post-commit deletion is retryable and, importantly, never rolls back files the committed message still references. */
export async function cleanupAttachments(harness: Harness, files: FileBackend, chat: number, paths: readonly string[], context: Context) {
	const unique = [...new Set(paths)];
	const key = JSON.stringify(unique);
	if (!unique.length) return;
	await harness.commit(async (tx) => {
		const pending = (await tx.doc(RequestDoc, chat as ConversationId)).pendingAttachmentDeletes ??= [];
		if (!pending.some((item) => item.paths.length === unique.length && item.paths.every((path, index) => path === unique[index]))) {
			pending.push({ chat, paths: unique });
		}
	}, context);
	try {
		await discardAttachments(files, chat, unique);
	} catch {
		return; // The durable intent is retried on the next Engine.
	}
	await harness.commit(async (tx) => {
		const requests = await tx.doc(RequestDoc, chat as ConversationId);
		requests.pendingAttachmentDeletes = (requests.pendingAttachmentDeletes ?? []).filter((item) => JSON.stringify(item.paths) !== key);
	}, context);
}

export async function resumeAttachmentDeletes(harness: Harness, files: FileBackend, context: Context, onError: (error: unknown) => void) {
	const workspace = await harness.snapshot(WorkspaceDoc, context);
	for (const chat of workspace?.chats ?? []) {
		const requests = await harness.snapshot(RequestDoc, chat.id as ConversationId, context);
		for (const pending of requests?.pendingAttachmentDeletes ?? []) {
			try {
				await discardAttachments(files, chat.id, pending.paths);
				await harness.commit(async (tx) => {
					const doc = await tx.doc(RequestDoc, chat.id as ConversationId);
					doc.pendingAttachmentDeletes = (doc.pendingAttachmentDeletes ?? []).filter((item) => JSON.stringify(item.paths) !== JSON.stringify(pending.paths));
				}, context);
			} catch (error) {
				onError(error);
			}
		}
	}
}

const imageOf = (item: StoredAttachment): ImageContent => ({ type: "image", data: toBase64(item.data), mimeType: item.mimeType });

export function contentForSend(text: string, attachments: readonly StoredAttachment[]): UserInput {
	return composeUserContent(text, attachments, attachments.filter(isImageAttachment).map(imageOf));
}

export function contentForUpdate(
	content: UserInput,
	text: string | undefined,
	added: readonly StoredAttachment[],
	removed: ReadonlySet<string>,
): UserInput {
	const existing = attachmentRefs(content);
	for (const path of removed) {
		safeAttachmentPath(path);
		if (!existing.some((item) => item.path === path)) invalid(`Attachment ${path} does not belong to this queued message.`);
	}
	const addedPaths = new Set(added.map((item) => item.path));
	const refs = [...existing.filter((item) => !removed.has(item.path) && !addedPaths.has(item.path)), ...added];
	if (refs.length > MAX_ATTACHMENTS) invalid(`A message can have at most ${MAX_ATTACHMENTS} attachments.`);
	if (refs.reduce((sum, item) => sum + item.size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES) {
		invalid("Attachments in one message are limited to 24 MiB in total.");
	}
	const oldImages = typeof content === "string" ? [] : content.filter((block): block is ImageContent => block.type === "image");
	const byPath = new Map<string, ImageContent>();
	let oldIndex = 0;
	for (const item of existing.filter(isImageAttachment)) {
		const image = oldImages[oldIndex++];
		if (image) byPath.set(item.path, image);
	}
	const addedByPath = new Map(added.map((item) => [item.path, imageOf(item)] as const));
	const images = refs.filter(isImageAttachment).map((item) => {
		const image = addedByPath.get(item.path) ?? byPath.get(item.path);
		if (!image) invalid(`The image content for ${item.path} is unavailable.`);
		return image;
	});
	// Image-only submissions from older versions have no metadata; editing their text must not discard them.
	images.push(...oldImages.slice(oldIndex));
	const nextText = text ?? editableText(content);
	if (!nextText.trim() && !refs.length && !images.length) invalid("The message cannot be empty.");
	return composeUserContent(nextText, refs, images);
}

export function requireContentVision(services: EngineServices, ref: ModelRef | null | undefined, content: UserInput) {
	if (typeof content === "string" || !content.some((block) => block.type === "image")) return;
	if (!ref) invalid("This message contains an image. Choose a vision-capable model first.");
	const model = services.models.getModel(ref.provider, ref.modelId);
	if (!model) invalid(`The selected model ${ref.modelId} is unavailable. Choose a vision-capable model before sending.`);
	if (!model.input.includes("image")) invalid(`${model.name ?? model.id} cannot process images. Choose a vision-capable model before sending.`);
}

export async function queuedContent(harness: Harness, id: ConversationId, submissionId: number, context: Context): Promise<UserInput | undefined> {
	const inbox = await harness.snapshot(InboxDoc, id, context);
	const item = inbox?.items.find((item) => item.id === submissionId && (item.mode === "steer" || item.mode === "followUp"));
	return item && item.mode !== "write" ? item.content : undefined;
}

/** Kept for tests and callers that only need metadata from a raw inbox item. */
export const refsOfQueued = attachmentRefs;
