import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { openDatabase, transaction } from "../lib/idb.ts";

const STORE = "credentials";

export class IndexedDbCredentialStore implements CredentialStore {
	#db: Promise<IDBDatabase>;
	/** Writes one after another: an OAuth refresh runs inside `modify`, so a rotated token is never exchanged twice. */
	#line: Promise<unknown> = Promise.resolve();

	constructor(name = "oshawott-credentials") {
		this.#db = openDatabase(name, (db) => db.createObjectStore(STORE));
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return transaction(await this.#db, STORE, "readonly", (store) => store.get(providerId) as IDBRequest<Credential | undefined>);
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		let keys!: IDBRequest<IDBValidKey[]>;
		const values = await transaction(await this.#db, STORE, "readonly", (store) => {
			keys = store.getAllKeys();
			return store.getAll() as IDBRequest<Credential[]>;
		});
		return keys.result.map((key, i) => ({ providerId: String(key), type: values[i]!.type }));
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
			await transaction(await this.#db, STORE, "readwrite", (store) => store.put(next, providerId));
			return next;
		}, options);
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#queue(async () => {
			await transaction(await this.#db, STORE, "readwrite", (store) => store.delete(providerId));
		}, options);
	}
}
