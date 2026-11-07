// The Broker: the browser shell, served as `Browser` at `BrokerHost()`. It holds no state of its own; whatever must
// survive is the Engine's. It runs where the extension APIs are: the service worker (Chromium) or the event page
// (Firefox).
import { Browser } from "../contracts/browser.ts";
import { BrokerHost, type Principal } from "../contracts/hosts.ts";
import { type Context, createHost, defineFacet, type Host } from "../lib/chord.ts";
import { sitePattern } from "../platform/patterns.ts";
import { ext, type TabInfo } from "../platform/webext.ts";

export const WAKE_ALARM = "oshawatt:wake";
/** While a run is active, a recovery alarm this far ahead (Chromium's minimum alarm delay is 30 s). */
const HEARTBEAT_MS = 60_000;

function tabOf(tab: TabInfo) {
	return {
		tabId: tab.id ?? -1,
		windowId: tab.windowId ?? -1,
		url: tab.url ?? "",
		title: tab.title ?? "",
		active: tab.active ?? false,
	};
}

/** Injects the page bundle into `tabId`: first its tab id, then the script (both in the isolated world). */
export async function injectPage(tabId: number) {
	await ext.scripting.executeScript({
		target: { tabId },
		func: ((id: number) => {
			(globalThis as { __oshawattTabId?: number }).__oshawattTabId = id;
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
		onError: (error) => console.debug("[oshawatt broker]", error),
	});
	await host.load(
		[
			{
				name: "oshawatt.broker",
				facet: defineFacet<Principal>((self) => {
					self.serve(Browser, (_params, principal) => {
						if (principal.kind !== "engine") throw new Error("Only the Engine uses the browser.");
						return {
							variant: "engine",
							members: {
								listTabs: async () => (await ext.tabs.query({})).map(tabOf),
								activeTab: async ({ windowId }) => {
									const [tab] = await ext.tabs.query(
										windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId },
									);
									return tab ? tabOf(tab) : null;
								},
								openTab: async ({ url, active }) => tabOf(await ext.tabs.create({ url, active: active ?? true })),
								attach: async ({ tabId }) => {
									await injectPage(tabId);
									return null;
								},
								hasAccess: async ({ url }) => {
									const pattern = sitePattern(url);
									return pattern !== undefined && (await ext.permissions.contains({ origins: [pattern] }));
								},
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
