// Firefox's event page: the Broker and the Engine in one document (Firefox has no offscreen documents, and its event
// page has a DOM and Workers). They are still two Chord hosts, joined by a memory link, so the code above them is the
// same as on Chromium. Open views (the sidebar) keep an event page alive; alarms bring it back after an unload.
import { MESSAGES } from "../contracts/hosts.ts";
import { startBroker } from "../broker/broker.ts";
import { runEngine } from "../engine/browser.ts";
import { BACKGROUND_CONTEXT, memoryLinkPair } from "../lib/chord.ts";
import "../platform/target.ts";
import { ext } from "../platform/webext.ts";

const context = BACKGROUND_CONTEXT;
const broker = startBroker(context);

// Listeners at the top level, synchronously: they are what wakes this page.
ext.runtime.onMessage.addListener((message) => {
	// This page is the Engine's document: being awake is the answer.
	if ((message as { type?: unknown } | null)?.type === MESSAGES.ensureEngine) return Promise.resolve({ ok: true });
	return undefined;
});
ext.alarms.onAlarm.addListener(() => {
	// Waking this page started the Engine, which resumes on open.
});
ext.action.onClicked.addListener(() => void (ext.sidebarAction?.toggle?.() ?? ext.sidebarAction?.open()));
// Test hook: WebDriver cannot reach extension pages, so a dev build installed next to a self-test tab opens its panel
// in self-test mode, which reports to that tab's server (scripts/smoke-firefox.mjs).
if (__OSHAWATT_DEV__) {
	ext.runtime.onInstalled.addListener(async () => {
		const tab = (await ext.tabs.query({})).find((t) => t.url?.includes("oshawatt-selftest"));
		if (tab?.url) void ext.tabs.create({ url: `panel.html?selftest=${encodeURIComponent(new URL(tab.url).origin)}` });
	});
}

void runEngine({
	broker: async () => {
		const [engineEnd, brokerEnd] = memoryLinkPair();
		(await broker).accept(brokerEnd, { principal: { kind: "engine" }, trusted: true }, context);
		return engineEnd;
	},
});
