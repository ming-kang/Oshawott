import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";

const STORE = "models";

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The models operation was aborted.", "AbortError");
}

/** Settle only when the transaction finishes, and abort it if the caller's signal fires. */
async function transaction<T>(
	db: IDBDatabase,
	mode: IDBTransactionMode,
	work: (store: IDBObjectStore) => IDBRequest<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const request = work(tx.objectStore(STORE));
		let settled = false;

		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		const fail = (reason: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(reason);
		};
		const onAbort = () => {
			fail(abortReason(signal!));
			try {
				tx.abort();
			} catch {
				// The transaction may already have completed or aborted.
			}
		};

		request.onerror = () => fail(request.error ?? tx.error ?? new Error("The models request failed."));
		tx.onerror = () => fail(tx.error ?? request.error ?? new Error("The models transaction failed."));
		tx.onabort = () =>
			fail(
				signal?.aborted
					? abortReason(signal)
					: (tx.error ?? request.error ?? new DOMException("The models transaction was aborted.", "AbortError")),
			);
		tx.oncomplete = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(request.result);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
	});
}

export class IndexedDbModelsStore implements ModelsStore {
	#db: Promise<IDBDatabase>;

	constructor(name = "oshawott-models") {
		this.#db = new Promise((resolve, reject) => {
			const open = indexedDB.open(name, 1);
			open.onupgradeneeded = () => open.result.createObjectStore(STORE);
			open.onsuccess = () => resolve(open.result);
			open.onerror = () => reject(open.error ?? new Error("Failed to open the models database."));
		});
	}

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const db = await this.#db;
		return transaction<ModelsStoreEntry | undefined>(db, "readonly", (store) => store.get(providerId), options?.signal);
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		const db = await this.#db;
		await transaction(db, "readwrite", (store) => store.put(entry, providerId), options?.signal);
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		const db = await this.#db;
		await transaction(db, "readwrite", (store) => store.delete(providerId), options?.signal);
	}
}
