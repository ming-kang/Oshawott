import { Browser, type Tab } from "../contracts/browser.ts";
import { BrokerHost, type Principal } from "../contracts/hosts.ts";
import { type Context, createHost, defineFacet, type Host } from "../lib/chord.ts";
import { sitePattern } from "../platform/patterns.ts";
import { ext, type TabInfo } from "../platform/webext.ts";

export const WAKE_ALARM = "oshawott:wake";
/** While a run is active, a recovery alarm this far ahead (Chromium's minimum alarm delay is 30 s). */
const HEARTBEAT_MS = 60_000;

const DONE = Symbol("loaded");
/** How long a navigation may take before the tools get the tab as it is. */
const LOAD_TIMEOUT_MS = 15_000;

async function hasAccess(url: string) {
	const pattern = sitePattern(url);
	return pattern !== undefined && (await ext.permissions.contains({ origins: [pattern] }));
}

async function tabOf(tab: TabInfo): Promise<Tab> {
	const url = tab.url ?? "";
	return {
		tabId: tab.id ?? -1,
		windowId: tab.windowId ?? -1,
		url,
		title: tab.title ?? "",
		active: tab.active ?? false,
		access: await hasAccess(url),
	};
}

const tabsOf = (tabs: readonly TabInfo[]) => Promise.all(tabs.map(tabOf));

/** Runs a navigation and waits for the tab's next finished load, so the next tool reads the new page, not the old one. */
async function loaded(tabId: number, navigate: () => Promise<unknown>, started = false): Promise<Tab> {
	let listener: Parameters<typeof ext.tabs.onUpdated.addListener>[0] | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			let loading = started;
			listener = (id, change) => {
				if (id !== tabId) return;
				if (change.status === "loading") loading = true;
				else if (change.status === "complete" && loading) resolve();
			};
			ext.tabs.onUpdated.addListener(listener);
			timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
			navigate().catch(reject);
		});
	} finally {
		clearTimeout(timer);
		if (listener) ext.tabs.onUpdated.removeListener(listener);
	}
	return tabOf(await ext.tabs.get(tabId));
}

export async function injectPage(tabId: number) {
	await ext.scripting.executeScript({
		target: { tabId },
		func: ((id: number) => {
			(globalThis as { __oshawottTabId?: number }).__oshawottTabId = id;
		}) as (...args: never[]) => unknown,
		args: [tabId],
	});
	await ext.scripting.executeScript({ target: { tabId }, files: ["page.js"] });
}

export async function armWake({ active, at }: { active: boolean; at?: number | undefined }) {
	const heartbeat = active ? Date.now() + HEARTBEAT_MS : undefined;
	const when = heartbeat === undefined ? at : at === undefined ? heartbeat : Math.min(heartbeat, at);
	if (when === undefined) await ext.alarms.clear(WAKE_ALARM);
	else await ext.alarms.create(WAKE_ALARM, { when });
}

export async function startBroker(context: Context): Promise<Host<Principal>> {
	const host = createHost<Principal>({
		address: BrokerHost(),
		principal: { kind: "broker" },
		onError: (error) => console.debug("[oshawott broker]", error),
	});
	await host.load(
		[
			{
				name: "oshawott.broker",
				facet: defineFacet<Principal>((self) => {
					self.serve(Browser, (_params, principal) => {
						if (principal.kind !== "engine") throw new Error("Only the Engine uses the browser.");
						return {
							variant: "engine",
							members: {
								listTabs: async () => tabsOf(await ext.tabs.query({})),
								getTab: async ({ tabId }) => {
									const tab = await ext.tabs.get(tabId).catch(() => undefined);
									return tab ? tabOf(tab) : null;
								},
								activeTab: async ({ windowId }) => {
									const [tab] = await ext.tabs.query(
										windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId },
									);
									return tab ? tabOf(tab) : null;
								},
								openTab: async ({ url, active }) => {
									const tab = await ext.tabs.create({ url, active: active ?? true });
									// Already loading: wait for that load, unless it finished before the listener was there.
									return loaded(tab.id!, async () => {
										if ((await ext.tabs.get(tab.id!)).status === "complete") throw DONE;
									}, true).catch(async (error) => {
										if (error !== DONE) throw error;
										return tabOf(await ext.tabs.get(tab.id!));
									});
								},
								navigateTab: ({ tabId, url, back }) =>
									loaded(tabId, () => back || url === undefined ? ext.tabs.goBack(tabId) : ext.tabs.update(tabId, { url })),
								activateTab: async ({ tabId }) => tabOf(await ext.tabs.update(tabId, { active: true })),
								closeTab: async ({ tabId }) => {
									await ext.tabs.remove(tabId);
									return null;
								},
								attach: async ({ tabId }) => {
									await injectPage(tabId);
									return null;
								},
								hasAccess: ({ url }) => hasAccess(url),
								armWake: async (wake) => {
									await armWake(wake);
									return null;
								},
							},
						};
					});
				}),
			},
		],
		context,
	);
	return host;
}
