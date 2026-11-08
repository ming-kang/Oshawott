// Refs name `<page load>.<snapshot>.e<n>`: a ref from an earlier snapshot, another page load or before a navigation
// cannot resolve, so a stale ref never reaches a different element that happens to have the same number.

export interface Connected {
	readonly isConnected: boolean;
}

const REF = /^([a-z0-9]+)\.(\d+)\.e(\d+)$/;
const PAGE_LOAD_CHARS = 8;

/** The URL a snapshot belongs to: a fragment change keeps the document and its refs. */
export function pageUrl(url: string): string {
	const hash = url.indexOf("#");
	return hash < 0 ? url : url.slice(0, hash);
}

/** About 41 random bits: two loads of one tab sharing an id, a snapshot count and a URL is negligible. */
function pageLoadId(): string {
	return [...crypto.getRandomValues(new Uint8Array(PAGE_LOAD_CHARS))].map((byte) => (byte % 36).toString(36)).join("");
}

export class RefTable<T extends object & Connected> {
	readonly pageLoad: string;
	#generation = 0;
	#url: string | undefined;
	/** The page left the snapshot's URL; coming back does not revive its refs. */
	#navigated = false;
	#byRef = new Map<string, WeakRef<T>>();
	#byTarget = new WeakMap<T, string>();

	constructor(pageLoad = pageLoadId()) {
		this.pageLoad = pageLoad;
	}

	/** Starts a snapshot: every earlier ref stops resolving. */
	begin(url: string) {
		this.#generation++;
		this.#url = pageUrl(url);
		this.#navigated = false;
		this.#byRef = new Map();
		this.#byTarget = new WeakMap();
	}

	/** Records the page's URL now; leaving the snapshot's URL ends its refs for good. */
	observe(url: string) {
		if (this.#url !== undefined && this.#url !== pageUrl(url)) this.#navigated = true;
	}

	/** The target's ref in the current snapshot; after a navigation, in a new one (the old refs were stale anyway). */
	add(target: T, url: string): string {
		this.observe(url);
		if (this.#generation === 0 || this.#navigated) this.begin(url);
		const known = this.#byTarget.get(target);
		if (known) return known;
		const ref = `${this.pageLoad}.${this.#generation}.e${this.#byRef.size + 1}`;
		this.#byRef.set(ref, new WeakRef(target));
		this.#byTarget.set(target, ref);
		return ref;
	}

	resolve(ref: string, url: string): T {
		this.observe(url);
		const match = REF.exec(ref);
		if (!match) throw new Error(`"${ref}" is not an element ref: use a ref from the latest page_snapshot.`);
		if (match[1] !== this.pageLoad) throw new Error(`${ref} is from an earlier page load: take a new snapshot.`);
		if (Number(match[2]) !== this.#generation) throw new Error(`${ref} is from an earlier snapshot: take a new snapshot.`);
		if (this.#navigated) throw new Error(`The page navigated since ${ref} was taken: take a new snapshot.`);
		const found = this.#byRef.get(ref)?.deref();
		if (!found?.isConnected) throw new Error(`${ref} is no longer on the page: take a new snapshot.`);
		return found;
	}
}
