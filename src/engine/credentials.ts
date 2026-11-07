// pi-ai's credential store in the Engine's own IndexedDB database. Keys never leave the Engine's document: panels set
// them through `Workspace.setApiKey` and see only whether a provider is configured.
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const STORE = "credentials";

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
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

	async #store(mode: IDBTransactionMode) {
		return (await this.#db).transaction(STORE, mode).objectStore(STORE);
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return (await request((await this.#store("readonly")).get(providerId))) as Credential | undefined;
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const store = await this.#store("readonly");
		const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
		return keys.map((key, i) => ({ providerId: String(key), type: (values[i] as Credential).type }));
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const run = this.#line.then(async () => {
			const next = await fn(await this.read(providerId, options));
			const store = await this.#store("readwrite");
			if (next === undefined) await request(store.delete(providerId));
			else await request(store.put(next, providerId));
			return next;
		});
		this.#line = run.catch(() => {});
		return run;
	}

	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.modify(providerId, async () => undefined, options).then(() => {});
	}
}
