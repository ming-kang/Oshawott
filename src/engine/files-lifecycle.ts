// A chat removal spans Durable and the separate files database. Commit the intent with the removal, so submissions
// stop immediately; abort all owned work, clear the files, then acknowledge the intent. A crash or failed clear leaves
// a retryable intent. Startup finishes those before accepting panels. There is no cross-database atomicity claim.
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { Context } from "../lib/chord.ts";
import { WorkspaceDoc } from "./docs.ts";
import type { FileBackend } from "./files.ts";

async function finishDelete(harness: Harness, files: FileBackend, id: number, context: Context) {
	const conversation = await harness.conversation(id as ConversationId, context);
	await conversation?.abort(context, { background: true });
	await files.clear(id);
	await harness.commit(async (tx) => {
		const workspace = await tx.doc(WorkspaceDoc);
		workspace.pendingFileDeletes = (workspace.pendingFileDeletes ?? []).filter((pending) => pending !== id);
	}, context);
}

export async function deleteChatFiles(harness: Harness, files: FileBackend, id: number, context: Context) {
	await harness.commit(async (tx) => {
		const workspace = await tx.doc(WorkspaceDoc);
		workspace.chats = workspace.chats.filter((chat) => chat.id !== id);
		const pending = workspace.pendingFileDeletes ??= [];
		if (!pending.includes(id)) pending.push(id);
	}, context);
	await finishDelete(harness, files, id, context);
}

export async function resumeFileDeletes(harness: Harness, files: FileBackend, context: Context, onError: (error: unknown) => void) {
	const workspace = await harness.snapshot(WorkspaceDoc, context);
	for (const id of workspace?.pendingFileDeletes ?? []) {
		try {
			await finishDelete(harness, files, id, context);
		} catch (error) {
			// Other chats stay usable; this intent remains for a later retry rather than being silently dropped.
			onError(error);
		}
	}
}
