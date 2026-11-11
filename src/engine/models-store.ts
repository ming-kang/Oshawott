import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";
import { openDatabase, transaction } from "../lib/idb.ts";

const STORE = "models";

/** The discovered model catalogs; an operation's signal aborts its transaction, so a cancelled write never lands. */
export class IndexedDbModelsStore implements ModelsStore {
	#db: Promise<IDBDatabase>;

	constructor(name = "oshawott-models") {
		this.#db = openDatabase(name, (db) => db.createObjectStore(STORE));
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const get = (store: IDBObjectStore) => store.get(providerId) as IDBRequest<ModelsStoreEntry | undefined>;
		return transaction(await this.#db, STORE, "readonly", get, options?.signal);
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await transaction(await this.#db, STORE, "readwrite", (store) => store.put(entry, providerId), options?.signal);
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await transaction(await this.#db, STORE, "readwrite", (store) => store.delete(providerId), options?.signal);
	}
}
