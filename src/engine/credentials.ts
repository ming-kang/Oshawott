import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const STORE = "credentials";

/** Run `work` in one transaction and settle when it commits, so a write is never reported before it is durable. */
async function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const req = work(tx.objectStore(STORE));
		tx.oncomplete = () => resolve(req.result);
		tx.onabort = () => reject(tx.error ?? req.error ?? new DOMException("The credential transaction was aborted.", "AbortError"));
	});
}

export class IndexedDbCredentialStore implements CredentialStore {
	#db: Promise<IDBDatabase>;
	/** Writes one after another, as `modify` must be serialized. */
	#line: Promise<unknown> = Promise.resolve();

	constructor(name = "oshawott-credentials") {
		this.#db = new Promise((resolve, reject) => {
			const open = indexedDB.open(name, 1);
			open.onupgradeneeded = () => open.result.createObjectStore(STORE);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error);
		});
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await transaction(await this.#db, "readonly", (store) => store.get(providerId))) as Credential | undefined;
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const db = await this.#db;
		const [keys, values] = await new Promise<[IDBValidKey[], unknown[]]>((resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const store = tx.objectStore(STORE);
			const keys = store.getAllKeys();
			const values = store.getAll();
			tx.oncomplete = () => resolve([keys.result, values.result]);
			tx.onabort = () => reject(tx.error ?? new DOMException("The credential transaction was aborted.", "AbortError"));
		});
		return keys.map((key, i) => ({ providerId: String(key), type: (values[i] as Credential).type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const run = this.#line.then(async () => {
			const next = await fn(await this.read(providerId, options));
			const db = await this.#db;
			if (next === undefined) await transaction(db, "readwrite", (store) => store.delete(providerId));
			else await transaction(db, "readwrite", (store) => store.put(next, providerId));
			return next;
		});
		this.#line = run.catch(() => {});
		return run;
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.modify(providerId, async () => undefined, options).then(() => {});
	}
}
