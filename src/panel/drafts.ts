import type { AttachmentInput } from "../lib/attachments.ts";

export type ComposerDraft = {
	text: string;
	attachments: AttachmentInput[];
	updatedAt: number;
};

type StoredDraft = ComposerDraft & { key: string };
const keyOf = (chatId: number | undefined) => chatId === undefined ? "new" : String(chatId);

function request<T>(operation: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		operation.onsuccess = () => resolve(operation.result);
		operation.onerror = () => reject(operation.error);
	});
}

/** Panel-local drafts. Bytes use structured clone, not a second copy in extension local storage. */
export class DraftStore {
	readonly #db: IDBDatabase | undefined;
	readonly #memory = new Map<string, StoredDraft>();

	private constructor(db?: IDBDatabase) {
		this.#db = db;
		if (db) db.onversionchange = () => db.close();
	}

	static async open(name = "oshawott-drafts"): Promise<DraftStore> {
		if (typeof indexedDB === "undefined") return new DraftStore();
		try {
			const opening = indexedDB.open(name, 1);
			opening.onupgradeneeded = () => { opening.result.createObjectStore("drafts", { keyPath: "key" }); };
			return new DraftStore(await request(opening));
		} catch {
			// Private browsing or a disabled database must not disable the composer.
			return new DraftStore();
		}
	}

	async load(chatId: number | undefined): Promise<ComposerDraft | undefined> {
		const key = keyOf(chatId);
		const stored = this.#db
			? await request(this.#db.transaction("drafts", "readonly").objectStore("drafts").get(key)) as StoredDraft | undefined
			: this.#memory.get(key);
		if (!stored) return undefined;
		return {
			text: stored.text,
			updatedAt: stored.updatedAt,
			attachments: stored.attachments.map((item) => ({ ...item, data: new Uint8Array(item.data) })),
		};
	}

	async save(chatId: number | undefined, draft: ComposerDraft): Promise<void> {
		const key = keyOf(chatId);
		if (!draft.text && !draft.attachments.length) return this.remove(chatId);
		const stored: StoredDraft = { ...draft, key, attachments: draft.attachments.map((item) => ({ ...item, data: new Uint8Array(item.data) })) };
		if (!this.#db) {
			this.#memory.set(key, stored);
			return;
		}
		const tx = this.#db.transaction("drafts", "readwrite");
		tx.objectStore("drafts").put(stored);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error ?? new Error("Saving the draft was aborted"));
			tx.onerror = () => reject(tx.error);
		});
	}

	async remove(chatId: number | undefined): Promise<void> {
		const key = keyOf(chatId);
		if (!this.#db) {
			this.#memory.delete(key);
			return;
		}
		const tx = this.#db.transaction("drafts", "readwrite");
		tx.objectStore("drafts").delete(key);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error ?? new Error("Removing the draft was aborted"));
		});
	}

	close() {
		this.#db?.close();
	}
}
