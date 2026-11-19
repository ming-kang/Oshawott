// Durable and the file database cannot commit atomically, so deletion is coordinated by a retryable durable intent.
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { Context } from "../lib/chord.ts";
import { discardAttachments, safeAttachmentPath } from "./attachments.ts";
import { FileDeletesDoc, type FileDelete, WorkspaceDoc } from "./docs.ts";
import type { FileBackend } from "./files.ts";

async function finishDelete(harness: Harness, files: FileBackend, intent: FileDelete, context: Context) {
	if (intent.paths) {
		await discardAttachments(files, intent.chat, intent.paths);
	} else {
		const conversation = await harness.conversation(intent.chat as ConversationId, context);
		await conversation?.abort(context, { background: true });
		await files.clear(intent.chat);
	}
	await harness.commit(async (tx) => {
		const outbox = await tx.doc(FileDeletesDoc);
		outbox.pending = outbox.pending.filter((pending) => pending.id !== intent.id);
	}, context);
}

export async function deleteChatFiles(harness: Harness, files: FileBackend, id: number, context: Context) {
	const intent = await harness.commit(async (tx) => {
		const workspace = await tx.doc(WorkspaceDoc);
		workspace.chats = workspace.chats.filter((chat) => chat.id !== id);
		return intendChatDelete(tx, id);
	}, context);
	await finishDelete(harness, files, intent, context);
}

async function intendChatDelete(tx: Tx, chat: number): Promise<FileDelete> {
	const outbox = await tx.doc(FileDeletesDoc);
	const intent = { id: `chat:${chat}`, chat };
	outbox.pending = [...outbox.pending.filter((pending) => pending.chat !== chat), intent];
	return intent;
}

export async function intendAttachmentDeletes(tx: Tx, chat: number, paths: readonly string[]): Promise<void> {
	const unique = [...new Set(paths)].map(safeAttachmentPath);
	if (!unique.length) return;
	(await tx.doc(FileDeletesDoc)).pending.push({ id: crypto.randomUUID(), chat, paths: unique });
}

async function drainFileDeletes(harness: Harness, files: FileBackend, context: Context, onError: (error: unknown) => void,
	filter: (intent: FileDelete) => boolean) {
	for (const intent of (await harness.snapshot(FileDeletesDoc, context))?.pending ?? []) {
		if (!filter(intent)) continue;
		try {
			await finishDelete(harness, files, intent, context);
		} catch (error) {
			onError(error);
		}
	}
}

export function completeAttachmentDeletes(harness: Harness, files: FileBackend, chat: number, context: Context, onError: (error: unknown) => void) {
	return drainFileDeletes(harness, files, context, onError, (intent) => intent.chat === chat && intent.paths !== undefined);
}

export async function resumeFileDeletes(harness: Harness, files: FileBackend, context: Context, onError: (error: unknown) => void) {
	const workspace = await harness.snapshot(WorkspaceDoc, context);
	if (workspace?.pendingFileDeletes !== undefined) {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(WorkspaceDoc);
			for (const chat of doc.pendingFileDeletes ?? []) await intendChatDelete(tx, chat);
			delete doc.pendingFileDeletes;
		}, context);
	}
	await drainFileDeletes(harness, files, context, onError, () => true);
}
