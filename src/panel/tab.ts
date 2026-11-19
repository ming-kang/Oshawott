import { isHttpUrl } from "../platform/patterns.ts";
import { ext, type TabInfo } from "../platform/webext.ts";

export interface TargetTab {
	readonly id: number;
	readonly title: string;
	readonly url: string;
	readonly favIconUrl?: string;
	readonly available: boolean;
}

const own = (tab: TabInfo) => (tab.url ?? "").startsWith(ext.runtime.getURL(""));

async function pick(): Promise<TabInfo | undefined> {
	const [active] = await ext.tabs.query({ active: true, currentWindow: true });
	if (active && !own(active)) return active;
	const others = (await ext.tabs.query({})).filter((tab) => !own(tab) && tab.id !== undefined);
	return others.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
}

function describe(tab: TabInfo): TargetTab {
	const url = tab.url ?? "";
	return {
		id: tab.id!,
		title: tab.title || url,
		url,
		...(tab.favIconUrl && /^(https?:|data:image\/)/.test(tab.favIconUrl) ? { favIconUrl: tab.favIconUrl } : {}),
		available: isHttpUrl(url),
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
		addEventListener("focus", refresh);
		refresh();
	}

	async refresh() {
		const ticket = ++this.#pending;
		const tab = await pick().catch(() => undefined);
		const next = tab?.id === undefined ? undefined : describe(tab);
		if (ticket !== this.#pending) return;
		this.#current = next;
		for (const listener of this.#listeners) listener(next);
	}
}
