import type { AttachmentInput } from "../lib/attachments.ts";
import { openDatabase, transaction } from "../lib/idb.ts";

export type ComposerDraft = {
	text: string;
	attachments: AttachmentInput[];
	updatedAt: number;
};

type StoredDraft = ComposerDraft & { key: string };
const STORE = "drafts";
const keyOf = (chatId: number | undefined) => chatId === undefined ? "new" : String(chatId);
const copied = <T extends ComposerDraft>(draft: T): T => ({
	...draft, attachments: draft.attachments.map((item) => ({ ...item, data: new Uint8Array(item.data) })),
});

/** Panel-local drafts. Bytes use structured clone, not a second copy in extension local storage. */
export class DraftStore {
	readonly #db: IDBDatabase | undefined;
	readonly #memory = new Map<string, StoredDraft>();

	private constructor(db?: IDBDatabase) {
		this.#db = db;
	}

	static async open(name = "oshawott-drafts"): Promise<DraftStore> {
		if (typeof indexedDB === "undefined") return new DraftStore();
		try {
			return new DraftStore(await openDatabase(name, (db) => db.createObjectStore(STORE, { keyPath: "key" })));
		} catch {
			// Private browsing or a disabled database must not disable the composer.
			return new DraftStore();
		}
	}

	async load(chatId: number | undefined): Promise<ComposerDraft | undefined> {
		const key = keyOf(chatId);
		const stored = this.#db
			? await transaction(this.#db, STORE, "readonly", (store) => store.get(key) as IDBRequest<StoredDraft | undefined>)
			: this.#memory.get(key);
		if (!stored) return undefined;
		const { text, updatedAt, attachments } = copied(stored);
		return { text, updatedAt, attachments };
	}

	async save(chatId: number | undefined, draft: ComposerDraft): Promise<void> {
		const key = keyOf(chatId);
		if (!draft.text && !draft.attachments.length) return this.remove(chatId);
		const stored: StoredDraft = { ...copied(draft), key };
		if (this.#db) await transaction(this.#db, STORE, "readwrite", (store) => store.put(stored));
		else this.#memory.set(key, stored);
	}

	async remove(chatId: number | undefined): Promise<void> {
		const key = keyOf(chatId);
		if (this.#db) await transaction(this.#db, STORE, "readwrite", (store) => store.delete(key));
		else this.#memory.delete(key);
	}

	close() {
		this.#db?.close();
	}
}
