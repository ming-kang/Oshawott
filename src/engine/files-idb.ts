// Chats' files in IndexedDB, in a database of their own beside Durable's: entries in `meta`, file bytes in `data`, both
// keyed `[chat, path]`, so listing a directory never loads its files and a chat's tree is one key range.
import type { Entry, FileBackend, FileTx } from "./files.ts";

const STORES = ["meta", "data"] as const;

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

/** Keys `[chat, path]` of every path that starts with `prefix` (which ends in `/`): up to the next character, `0`. */
const startingWith = (chat: number, prefix: string) => IDBKeyRange.bound([chat, prefix], [chat, `${prefix.slice(0, -1)}0`], false, true);
/** Every key of `chat`: arrays sort after strings, so `[chat, []]` is past every `[chat, path]`. */
const allOf = (chat: number) => IDBKeyRange.bound([chat], [chat, []]);

export class IndexedDbFileBackend implements FileBackend {
	readonly #db: IDBDatabase;

	private constructor(db: IDBDatabase) {
		this.#db = db;
		db.onversionchange = () => db.close();
	}

	static async open(name = "oshawott-files"): Promise<IndexedDbFileBackend> {
		const opening = indexedDB.open(name, 1);
		opening.onupgradeneeded = () => {
			for (const store of STORES) opening.result.createObjectStore(store);
		};
		return new IndexedDbFileBackend(await request(opening));
	}

	transact<T>(chat: number, mode: "readonly" | "readwrite", fn: (tx: FileTx) => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const tx = this.#db.transaction(STORES, mode);
			const meta = tx.objectStore("meta");
			const data = tx.objectStore("data");
			let result: { value: T } | undefined;
			let failure: { error: unknown } | undefined;
			tx.oncomplete = () => failure ? reject(failure.error) : result ? resolve(result.value) : reject(new Error("The file transaction ended early"));
			tx.onabort = () => reject(failure ? failure.error : tx.error ?? new Error("The file transaction was aborted"));
			const abort = (error: unknown) => {
				failure = { error };
				try {
					tx.abort();
				} catch {
					// If the callback awaited non-transaction work, the transaction may already have ended.
					reject(error);
				}
			};
			const files: FileTx = {
				get: (path) => request(meta.get([chat, path]) as IDBRequest<Entry | undefined>),
				data: async (path) => {
					const bytes = (await request(data.get([chat, path]))) as Uint8Array | ArrayBuffer | undefined;
					return bytes === undefined || bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
				},
				below: async (dir) => {
					const range = startingWith(chat, dir === "/" ? "/" : `${dir}/`);
					const [keys, entries] = await Promise.all([request(meta.getAllKeys(range)), request(meta.getAll(range) as IDBRequest<Entry[]>)]);
					return keys.map((key, index) => [(key as [number, string])[1], entries[index]!] as const);
				},
				put: (path, entry, bytes) => {
					meta.put(entry, [chat, path]);
					if (entry.kind === "file") data.put(bytes ?? new Uint8Array(), [chat, path]);
					else data.delete([chat, path]);
				},
				delete: (path) => {
					meta.delete([chat, path]);
					data.delete([chat, path]);
				},
			};
			try {
				Promise.resolve(fn(files)).then((value) => { result = { value }; }, abort);
			} catch (error) {
				// A synchronous callback (or put/data cloning) can throw after queueing writes. It must abort too.
				abort(error);
			}
		});
	}

	async clear(chat: number): Promise<void> {
		const tx = this.#db.transaction(STORES, "readwrite");
		for (const store of STORES) tx.objectStore(store).delete(allOf(chat));
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error ?? new Error("Clearing the chat's files was aborted"));
		});
	}

	close(): void {
		this.#db.close();
	}
}
