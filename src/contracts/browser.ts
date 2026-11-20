import { arr, bool, int, method, nul, num, obj, oneOf, opt, remote, type Static, str, union } from "../lib/chord.ts";
import { BrokerHost } from "./hosts.ts";

export const TabSchema = obj({
	tabId: int(),
	windowId: int(),
	url: str(),
	title: str(),
	active: bool(),
	/** The tab's group when it is in one: openTab returns the group it put the new tab in. */
	groupId: opt(int()),
});
export type Tab = Static<typeof TabSchema>;

export const Browser = remote("oshawott.browser", {
	version: 6,
	params: {},
	hostAddress: () => BrokerHost(),
	variants: {
		engine: {
			methods: {
				listTabs: method(undefined, arr(TabSchema)),
				activeTab: method(obj({ windowId: opt(int()) }), union([TabSchema, nul()])),
				getTab: method(obj({ tabId: int() }), union([TabSchema, nul()])),
				/** `group`: put the new tab in that tab group when it still exists, else in this extension's own group. */
				openTab: method(obj({ url: str(), active: opt(bool()), group: opt(union([int(), nul()])) }), TabSchema),
				/** Loads `url` in the tab, or moves in its history (`back`, `forward`, `reload`); returns once the page has loaded. */
				navigateTab: method(obj({ tabId: int(), url: opt(str()), history: opt(oneOf("back", "forward", "reload")) }), TabSchema),
				activateTab: method(obj({ tabId: int() }), TabSchema),
				closeTab: method(obj({ tabId: int() })),
				/**
				 * The tab after an action: waits briefly for a navigation the action started and for that load to finish,
				 * then returns the tab as it is.
				 */
				settle: method(obj({ tabId: int() }), TabSchema),
				/** A JPEG of the visible tab's viewport as a data URL; the tab must be the active one of its window. */
				capture: method(obj({ tabId: int() }), obj({ dataUrl: str() })),
				/** One id per browser session, kept in storage.session; tab ids repeat after a restart, this does not. */
				session: method(undefined, str()),
				/**
				 * Brings the page host of `tabId` up: injects the page bundle when the tab has none. The page then connects
				 * its Port and the Engine's route to `TabHost({ tabId })` completes.
				 */
				attach: method(obj({ tabId: int() })),
				siteAccess: method(obj({ tabId: int() })),
				/**
				 * Arms the Engine's wakeup from Durable's `Wake` (`onWake`): an alarm at `at`, a recovery heartbeat while
				 * `active`, none when both are absent. The alarm brings the Engine back, which reopens and resumes.
				 */
				armWake: method(obj({ active: bool(), at: opt(num()) })),
			},
		},
	},
});
