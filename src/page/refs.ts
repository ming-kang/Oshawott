// Refs name `<page load>.e<n>`: a ref stays valid for its element's life within one page load, until the
// document's URL (sans fragment) changes — a later or narrower snapshot never invalidates earlier refs. A ref
// from another page load, or issued before a navigation, cannot resolve, so a stale ref never reaches a
// different element that happens to have the same number.

export interface Connected {
	readonly isConnected: boolean;
}

const REF = /^([a-z0-9]+)\.e(\d+)$/;
const PAGE_LOAD_CHARS = 6;

/** The URL a page belongs to: a fragment change keeps the document and its refs. */
export function pageUrl(url: string): string {
	const hash = url.indexOf("#");
	return hash < 0 ? url : url.slice(0, hash);
}

/** About 31 random bits: two loads of one tab sharing an id and a URL is negligible. */
function pageLoadId(): string {
	return [...crypto.getRandomValues(new Uint8Array(PAGE_LOAD_CHARS))].map((byte) => (byte % 36).toString(36)).join("");
}

export class RefTable<T extends object & Connected> {
	readonly pageLoad: string;
	#url: string | undefined;
	/** Refs count up for the whole page load; a navigation never restarts them. */
	#next = 1;
	/** Every ref up to this number was issued before a navigation and no longer resolves. */
	#retired = 0;
	#byRef = new Map<string, WeakRef<T>>();
	#byTarget = new WeakMap<T, string>();

	constructor(pageLoad = pageLoadId()) {
		this.pageLoad = pageLoad;
	}

	/** Records the page's URL now; a different document URL retires every ref issued so far. */
	observe(url: string) {
		const current = pageUrl(url);
		if (this.#url === current) return;
		this.#url = current;
		if (this.#retired === 0 && this.#byRef.size === 0) return;
		this.#retired = this.#next - 1;
		this.#byRef = new Map();
		this.#byTarget = new WeakMap();
	}

	/** The target's ref; the same element always gets the same one while the document stays. */
	add(target: T, url: string): string {
		this.observe(url);
		const known = this.#byTarget.get(target);
		if (known) return known;
		const ref = `${this.pageLoad}.e${this.#next++}`;
		this.#byRef.set(ref, new WeakRef(target));
		this.#byTarget.set(target, ref);
		return ref;
	}

	resolve(ref: string, url: string): T {
		this.observe(url);
		const match = REF.exec(ref);
		if (!match) throw new Error(`"${ref}" is not an element ref: use a ref from a page_snapshot.`);
		if (match[1] !== this.pageLoad) throw new Error(`${ref} is from an earlier page load: take a new snapshot.`);
		if (Number(match[2]) <= this.#retired) throw new Error(`The page navigated since ${ref} was issued: take a new snapshot.`);
		const found = this.#byRef.get(ref)?.deref();
		if (!found?.isConnected) throw new Error(`${ref} is no longer on the page: take a new snapshot.`);
		return found;
	}
}
