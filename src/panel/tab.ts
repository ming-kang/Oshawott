// The tab the panel's prompts are about: the active tab of the panel's window, or, when the panel is itself a tab (a
// panel opened as a page), the user's most recently used other tab. With it, whether page tools may run there:
// `granted` (the site's host permission is held), `grantable` (an http(s) site; the user can allow it), or `unavailable`
// (browser and extension pages, where no extension may inject).
import { ext, type TabInfo } from "../platform/webext.ts";

export type Access = "granted" | "grantable" | "unavailable";

export interface TargetTab {
	readonly id: number;
	readonly title: string;
	readonly url: string;
	readonly favIconUrl?: string;
	readonly access: Access;
	/** The match pattern to request for `grantable`. */
	readonly pattern?: string;
}

const own = (tab: TabInfo) => (tab.url ?? "").startsWith(ext.runtime.getURL(""));

async function pick(): Promise<TabInfo | undefined> {
	const [active] = await ext.tabs.query({ active: true, currentWindow: true });
	if (active && !own(active)) return active;
	const others = (await ext.tabs.query({})).filter((tab) => !own(tab) && tab.id !== undefined);
	return others.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

async function describe(tab: TabInfo): Promise<TargetTab> {
	const url = tab.url ?? "";
	let pattern: string | undefined;
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") pattern = `${parsed.origin}/*`;
	} catch {
		pattern = undefined;
	}
	const access: Access = !pattern ? "unavailable" : (await ext.permissions.contains({ origins: [pattern] })) ? "granted" : "grantable";
	return {
		id: tab.id!,
		title: tab.title || url,
		url,
		...(tab.favIconUrl && /^(https?:|data:image\/)/.test(tab.favIconUrl) ? { favIconUrl: tab.favIconUrl } : {}),
		access,
		...(pattern ? { pattern } : {}),
	};
}

export class TabTracker {
	#current: TargetTab | undefined;
	#listeners = new Set<(tab: TargetTab | undefined) => void>();
	#pending = 0;

	get current() {
		return this.#current;
	}

	onChange(listener: (tab: TargetTab | undefined) => void) {
		this.#listeners.add(listener);
	}

	start() {
		const refresh = () => void this.refresh();
		ext.tabs.onActivated.addListener(refresh);
		ext.tabs.onUpdated.addListener((tabId, change) => {
			if (tabId === this.#current?.id || change.status === "complete") refresh();
		});
		ext.tabs.onRemoved.addListener(refresh);
		ext.permissions.onAdded?.addListener(refresh);
		ext.permissions.onRemoved?.addListener(refresh);
		addEventListener("focus", refresh);
		refresh();
	}

	async refresh() {
		const ticket = ++this.#pending;
		const tab = await pick().catch(() => undefined);
		const next = tab?.id === undefined ? undefined : await describe(tab).catch(() => undefined);
		if (ticket !== this.#pending) return;
		this.#current = next;
		for (const listener of this.#listeners) listener(next);
	}

	/**
	 * Asks for the current site's permission. Called straight from a click handler, before any await: Firefox grants
	 * a permission request only within the user's gesture.
	 */
	grant(): Promise<boolean> {
		const pattern = this.#current?.pattern;
		if (!pattern) return Promise.resolve(false);
		const asked = ext.permissions.request({ origins: [pattern] });
		return asked.then((granted) => {
			void this.refresh();
			return granted;
		});
	}
}
