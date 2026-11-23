import { Browser, type Tab } from "../contracts/browser.ts";
import { BrokerHost, type Principal } from "../contracts/hosts.ts";
import { type Context, createHost, defineFacet, type Host } from "../lib/chord.ts";
import { isFileUrl } from "../platform/patterns.ts";
import { ext, type TabInfo } from "../platform/webext.ts";

export const WAKE_ALARM = "oshawott:wake";
/** While a run is active, a recovery alarm this far ahead (Chromium's minimum alarm delay is 30 s). */
const HEARTBEAT_MS = 60_000;

const DONE = Symbol("loaded");
/** How long a navigation may take before the tools get the tab as it is. */
const LOAD_TIMEOUT_MS = 15_000;
/** How long after an action a navigation it caused may still begin loading. */
const SETTLE_WINDOW_MS = 400;
const GROUP_TITLE = "Oshawott";
const GROUP_COLOR = "purple";
const SITE_ACCESS_TIMEOUT_MS = 5 * 60_000;
const SITE_ACCESS_PROBE_MS = 1_000;
const SITE_ACCESS_REQUIRED = "Oshawott has no access to this site. Ask the user to grant site access in the browser prompt or the browser's extension settings, then retry.";
const LOCAL_FILE_ACCESS_REQUIRED =
	"Oshawott cannot read this local page. Ask the user to enable local file access in the browser's extension settings " +
	"(‘Allow access to file URLs’ in Chromium, or ‘Access local files on your computer’ in Firefox 153+), then retry. " +
	"The file must already be open as a regular document; built-in PDF viewers are not supported.";
/** Without storage.session: one id per broker lifetime, so closed tabs are still foreign after a restart. */
let sessionId: string | undefined;

function tabOf(tab: TabInfo): Tab {
	return {
		tabId: tab.id ?? -1,
		windowId: tab.windowId ?? -1,
		url: tab.url ?? "",
		title: tab.title ?? "",
		active: tab.active ?? false,
	};
}

const tabsOf = (tabs: readonly TabInfo[]) => tabs.map(tabOf);

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

/** Puts the tab in `group` when it still exists, else in this extension's own group. Best-effort: returns undefined without. */
async function groupTab(tabId: number, group: number | null | undefined, windowId: number | undefined): Promise<number | undefined> {
	const groupApi = ext.tabs.group;
	if (!groupApi) return undefined;
	if (group !== null && group !== undefined) {
		try {
			return await groupApi.call(ext.tabs, { groupId: group, tabIds: [tabId] });
		} catch {
			// The stored group is gone: fall through to this extension's own group.
		}
	}
	try {
		const groupId = await groupApi.call(ext.tabs, {
			tabIds: [tabId],
			...(windowId === undefined ? {} : { createProperties: { windowId } }),
		});
		await ext.tabGroups?.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR }).catch(() => undefined);
		return groupId;
	} catch {
		return undefined;
	}
}

/**
 * The tab after an action: waits briefly for a load the action may have started, then for its completion.
 * One listener through both waits, so a `complete` can never slip into the gap between them.
 */
async function settleTab(tabId: number): Promise<Tab> {
	let listener: Parameters<typeof ext.tabs.onUpdated.addListener>[0] | undefined;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	let loadTimer: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			let loading = false;
			listener = (id, change) => {
				if (id !== tabId) return;
				if (change.status === "loading") loading = true;
				// A finished load always settles the tab, whether we saw it start or not.
				else if (change.status === "complete") resolve();
			};
			ext.tabs.onUpdated.addListener(listener);
			settleTimer = setTimeout(() => {
				if (!loading) resolve();
			}, SETTLE_WINDOW_MS);
			loadTimer = setTimeout(resolve, LOAD_TIMEOUT_MS);
			ext.tabs.get(tabId).then(
				(tab) => {
					if (tab.status === "loading") loading = true;
				},
				reject,
			);
		});
	} finally {
		clearTimeout(settleTimer);
		clearTimeout(loadTimer);
		if (listener) ext.tabs.onUpdated.removeListener(listener);
	}
	return tabOf(await ext.tabs.get(tabId));
}

function missingSiteAccess(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Missing host permission for the tab|Cannot access contents of the page|must request permission to access (?:this|the respective) host/i.test(message);
}

async function canInject(tabId: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			ext.scripting.executeScript({ target: { tabId }, func: () => true }).then(() => true, (error: unknown) => {
				if (missingSiteAccess(error)) return false;
				throw error;
			}),
			new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), SITE_ACCESS_PROBE_MS); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The grant to blame when injection failed: file access for local documents, site access otherwise. */
async function accessRequired(tabId: number, cause: unknown): Promise<Error> {
	const tab = await ext.tabs.get(tabId).catch(() => undefined);
	return new Error(isFileUrl(tab?.url) ? LOCAL_FILE_ACCESS_REQUIRED : SITE_ACCESS_REQUIRED, { cause });
}

async function siteAccess(tabId: number, context: Context): Promise<void> {
	const tab = await ext.tabs.get(tabId);
	if (isFileUrl(tab.url)) {
		// A probe is the ground truth: old Firefox injects file:// pages without a grant the settings API would
		// report (it says false even when injection works); browsers that truly cannot inject get the error's steps.
		if (!(await canInject(tabId))) throw new Error(LOCAL_FILE_ACCESS_REQUIRED);
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const signal = context.abortSignal;
		let finished = false;
		const finish = (error?: unknown) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			ext.permissions.onAdded.removeListener(added);
			signal?.removeEventListener("abort", aborted);
			if (error) reject(error);
			else resolve();
		};
		const aborted = () => finish(new Error(SITE_ACCESS_REQUIRED));
		const check = (fetched: TabInfo | Promise<TabInfo>) => {
			void Promise.resolve(fetched).then(async (current) => {
				if (!current.url || !/^https?:\/\//i.test(current.url)) return true;
				const { protocol, hostname } = new URL(current.url);
				const granted = await ext.permissions.contains({ origins: [`${protocol}//${hostname}/*`] });
				return granted || canInject(tabId);
			}).then((granted) => {
				if (granted) finish();
			}, finish);
		};
		// The listener gets a permissions argument, so it asks for a fresh tab instead of reusing the first one.
		const added = () => check(ext.tabs.get(tabId));
		const timer = setTimeout(aborted, SITE_ACCESS_TIMEOUT_MS);
		ext.permissions.onAdded.addListener(added);
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) aborted();
		else check(tab);
	});
}

export async function injectPage(tabId: number) {
	try {
		await ext.scripting.executeScript({
			target: { tabId },
			func: ((id: number) => {
				(globalThis as { __oshawottTabId?: number }).__oshawottTabId = id;
			}) as (...args: never[]) => unknown,
			args: [tabId],
		});
		await ext.scripting.executeScript({ target: { tabId }, files: ["page.js"] });
	} catch (error) {
		if (missingSiteAccess(error)) throw await accessRequired(tabId, error);
		throw error;
	}
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
								openTab: async ({ url, active, group }) => {
									const tab = await ext.tabs.create({ url, active: active ?? true });
									const groupId = await groupTab(tab.id!, group, tab.windowId);
									// Already loading: wait for that load, unless it finished before the listener was there.
									const opened = await loaded(tab.id!, async () => {
										if ((await ext.tabs.get(tab.id!)).status === "complete") throw DONE;
									}, true).catch(async (error) => {
										if (error !== DONE) throw error;
										return tabOf(await ext.tabs.get(tab.id!));
									});
									return { ...opened, ...(groupId === undefined ? {} : { groupId }) };
								},
								navigateTab: ({ tabId, url, history }) =>
									loaded(tabId, () => history === "back" ? ext.tabs.goBack(tabId)
										: history === "forward" ? ext.tabs.goForward(tabId)
											: history === "reload" ? ext.tabs.reload(tabId)
												: ext.tabs.update(tabId, { url: url! })),
								activateTab: async ({ tabId }) => tabOf(await ext.tabs.update(tabId, { active: true })),
								closeTab: async ({ tabId }) => {
									await ext.tabs.remove(tabId);
									return null;
								},
								settle: async ({ tabId }) => settleTab(tabId),
								capture: async ({ tabId }) => {
									const tab = await ext.tabs.get(tabId);
									if (!tab.active || tab.windowId === undefined) {
										throw new Error(`Tab ${tabId} is not visible: bring it to the front with tab_activate first.`);
									}
									const capture = ext.tabs.captureVisibleTab;
									if (!capture) throw new Error("This browser cannot capture screenshots.");
									return { dataUrl: await capture.call(ext.tabs, tab.windowId, { format: "jpeg", quality: 85 }) };
								},
								session: async () => {
									const store = ext.storage?.session;
									if (!store) return sessionId ??= crypto.randomUUID();
									const stored = await store.get("oshawott-session");
									if (typeof stored["oshawott-session"] === "string") return stored["oshawott-session"];
									const id = sessionId = crypto.randomUUID();
									await store.set({ "oshawott-session": id });
									return id;
								},
								attach: async ({ tabId }) => {
									await injectPage(tabId);
									return null;
								},
								siteAccess: async ({ tabId }, ctx) => {
									await siteAccess(tabId, ctx);
									return null;
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
