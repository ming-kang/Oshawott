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
	/** Writes one after another: an OAuth refresh runs inside `modify`, so a rotated token is never exchanged twice. */
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

	/** `signal` cancels only the wait for the line: a write that has started always finishes. */
	#queue<T>(work: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const run = this.#line.then(() => {
			options?.signal?.throwIfAborted();
			return work();
		});
		this.#line = run.catch(() => {});
		return run;
	}

	/** Pi-AI's contract: `fn` returning undefined leaves the entry as it is (a refresh another request already did). */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.#queue(async () => {
			const current = await this.read(providerId);
			const next = await fn(current);
			if (next === undefined) return current;
			await transaction(await this.#db, "readwrite", (store) => store.put(next, providerId));
			return next;
		}, options);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#queue(async () => {
			await transaction(await this.#db, "readwrite", (store) => store.delete(providerId));
		}, options);
	}
}
