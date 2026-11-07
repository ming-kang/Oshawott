// The browser shell, served by the Broker and used by the Engine only: what needs extension APIs the Engine's
// document may lack (an offscreen document has `runtime` and nothing else).
import { arr, bool, int, method, nul, num, obj, opt, remote, str, union } from "../lib/chord.ts";
import { BrokerHost } from "./hosts.ts";

/** The file tool's permission failure marker, also recognized by the panel's fetch card. */
export const NO_ACCESS = "No access to";

export const TabSchema = obj({
	tabId: int(),
	windowId: int(),
	url: str(),
	title: str(),
	active: bool(),
});

export const Browser = remote("oshawatt.browser", {
	version: 1,
	params: {},
	hostAddress: () => BrokerHost(),
	variants: {
		engine: {
			methods: {
				listTabs: method(undefined, arr(TabSchema)),
				/** The active tab of the last focused window (or of `windowId`). */
				activeTab: method(obj({ windowId: opt(int()) }), union([TabSchema, nul()])),
				openTab: method(obj({ url: str(), active: opt(bool()) }), TabSchema),
				/**
				 * Brings the page host of `tabId` up: injects the page bundle when the tab has none. The page then connects
				 * its Port and the Engine's route to `TabHost({ tabId })` completes.
				 */
				attach: method(obj({ tabId: int() })),
				/** Whether the user has allowed the extension on `url`'s site (its host permission), for `fetch`. */
				hasAccess: method(obj({ url: str() }), bool()),
				/**
				 * Arms the Engine's wakeup from Durable's `Wake` (`onWake`): an alarm at `at`, a recovery heartbeat while
				 * `active`, none when both are absent. The alarm brings the Engine back, which reopens and resumes.
				 */
				armWake: method(obj({ active: bool(), at: opt(num()) })),
			},
		},
	},
});
