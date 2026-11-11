/** Settles with the request's result, or rejects with its error. */
export function settle<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Opens database `name`, letting `create` set up its object stores the first time. Another context deleting it closes it. */
export async function openDatabase(name: string, create: (db: IDBDatabase) => void): Promise<IDBDatabase> {
	const opening = indexedDB.open(name, 1);
	opening.onupgradeneeded = () => create(opening.result);
	const db = await settle(opening);
	db.onversionchange = () => db.close();
	return db;
}

/**
 * Runs `work` in one transaction of `store` and settles with its request's result once the transaction has committed,
 * so a write is never reported before it is durable. A failed request or an aborted transaction rejects; so does
 * `signal`, which also aborts the transaction, so a write it cancels never lands.
 */
export function transaction<T>(
	db: IDBDatabase,
	store: string,
	mode: IDBTransactionMode,
	work: (store: IDBObjectStore) => IDBRequest<T>,
	signal?: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const tx = db.transaction(store, mode);
		const request = work(tx.objectStore(store));
		let settled = false;
		const finish = (settleWith: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			settleWith();
		};
		const fail = (reason: unknown) => finish(() => reject(reason));
		const aborted = () => new DOMException("The transaction was aborted.", "AbortError");
		const onAbort = () => {
			fail(signal!.reason ?? aborted());
			try {
				tx.abort();
			} catch {
				// The transaction may already have completed or aborted.
			}
		};
		request.onerror = () => fail(request.error ?? tx.error ?? aborted());
		tx.onerror = () => fail(tx.error ?? request.error ?? aborted());
		tx.onabort = () => fail(signal?.aborted ? signal.reason ?? aborted() : tx.error ?? request.error ?? aborted());
		tx.oncomplete = () => finish(() => resolve(request.result));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
