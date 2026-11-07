import { MESSAGES, PORTS } from "../contracts/hosts.ts";
import { startBroker, WAKE_ALARM } from "../broker/broker.ts";
import { BACKGROUND_CONTEXT, type Host } from "../lib/chord.ts";
import { type PortLink, portLink } from "../link/port-link.ts";
import type { Principal } from "../contracts/hosts.ts";
import { ext } from "../platform/webext.ts";

const context = BACKGROUND_CONTEXT;
const ENGINE_URL = "engine.html";
let broker: Promise<Host<Principal>> | undefined;
let link: PortLink | undefined;
let creating: Promise<void> | undefined;

async function ensureEngine() {
	const url = ext.runtime.getURL(ENGINE_URL);
	const existing = await ext.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
	if (existing && existing.length > 0) return;
	creating ??= ext
		.offscreen!.createDocument({
			url: ENGINE_URL,
			reasons: ["WORKERS"],
			justification: "Runs the agent: its durable session, model requests, and code mode workers.",
		})
		.catch((error: unknown) => {
			// Another wake created it meanwhile.
			if (!/single offscreen|only a single/i.test(String(error))) throw error;
		})
		.finally(() => (creating = undefined));
	await creating;
}

async function connectToEngine() {
	if (link && !link.closed) return;
	const host = await (broker ??= startBroker(context));
	await ensureEngine();
	link = portLink(ext.runtime.connect({ name: PORTS.broker }), () => ext.runtime.lastError?.message);
	host.accept(link, { principal: { kind: "engine" } }, context);
}

// Listeners at the top level, synchronously: they are what wakes this worker.
ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	const type = (message as { type?: unknown } | null)?.type;
	const job = type === MESSAGES.ensureEngine ? ensureEngine() : type === MESSAGES.wakeBroker ? connectToEngine() : undefined;
	if (!job) return undefined;
	job.then(
		() => sendResponse({ ok: true }),
		(error: unknown) => sendResponse({ ok: false, error: String(error) }),
	);
	return true;
});
ext.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === WAKE_ALARM) void connectToEngine();
});
ext.runtime.onInstalled.addListener(() => void ext.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }));
ext.runtime.onStartup.addListener(() => void ensureEngine());
