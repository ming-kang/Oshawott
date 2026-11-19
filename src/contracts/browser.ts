import { arr, bool, int, method, nul, num, obj, opt, remote, type Static, str, union } from "../lib/chord.ts";
import { BrokerHost } from "./hosts.ts";

export const TabSchema = obj({
	tabId: int(),
	windowId: int(),
	url: str(),
	title: str(),
	active: bool(),
});
export type Tab = Static<typeof TabSchema>;

export const Browser = remote("oshawott.browser", {
	version: 3,
	params: {},
	hostAddress: () => BrokerHost(),
	variants: {
		engine: {
			methods: {
				listTabs: method(undefined, arr(TabSchema)),
				activeTab: method(obj({ windowId: opt(int()) }), union([TabSchema, nul()])),
				getTab: method(obj({ tabId: int() }), union([TabSchema, nul()])),
				openTab: method(obj({ url: str(), active: opt(bool()) }), TabSchema),
				/** Loads `url` in the tab, or goes one step `back` in its history; returns once the page has loaded. */
				navigateTab: method(obj({ tabId: int(), url: opt(str()), back: opt(bool()) }), TabSchema),
				activateTab: method(obj({ tabId: int() }), TabSchema),
				closeTab: method(obj({ tabId: int() })),
				/**
				 * Brings the page host of `tabId` up: injects the page bundle when the tab has none. The page then connects
				 * its Port and the Engine's route to `TabHost({ tabId })` completes.
				 */
				attach: method(obj({ tabId: int() })),
				/**
				 * Arms the Engine's wakeup from Durable's `Wake` (`onWake`): an alarm at `at`, a recovery heartbeat while
				 * `active`, none when both are absent. The alarm brings the Engine back, which reopens and resumes.
				 */
				armWake: method(obj({ active: bool(), at: opt(num()) })),
			},
		},
	},
});
