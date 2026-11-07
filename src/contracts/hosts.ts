// The hosts of Oshawott and who calls whom.
//
// Engine is the hub. It is the only context listening to `runtime.onConnect`; every other context connects to it:
// - what the Engine uses is a *route* of the Engine's host (Broker: browser APIs; Tab: one page's tools), and the host
//   at the other end `accept`s the Engine;
// - what uses the Engine is a *child* the Engine `accept`s (Panel), and that host `connect`s to the Engine.
// Port names say which of the two a port is for (`PORTS`).
import { hostKind, int } from "../lib/chord.ts";

export const EngineHost = hostKind("oshawott.engine");
export const BrokerHost = hostKind("oshawott.broker");
export const TabHost = hostKind("oshawott.tab", { tabId: int() });

/** Who calls, as links stamp it. A caller never names itself. */
export type Principal =
	| { readonly kind: "engine" }
	| { readonly kind: "broker" }
	| { readonly kind: "panel"; readonly instance: string }
	| { readonly kind: "tab"; readonly tabId: number };

export const PORTS = {
	/** Broker → Engine: the Broker's host accepts the Engine on it (the Engine's route to `BrokerHost`). */
	broker: "oshawott:broker",
	/** Page → Engine: the page's host accepts the Engine on it (the Engine's route to `TabHost`). */
	tab: "oshawott:tab",
	/** Panel → Engine: the Engine accepts the panel as a child. */
	panel: "oshawott:panel",
} as const;

/** One-shot messages (not links), which wake a sleeping service worker or event page. */
export const MESSAGES = {
	/** Panel → Broker: bring the Engine's document up (Chromium: create the offscreen document) before connecting. */
	ensureEngine: "oshawott:ensure-engine",
	/** Engine → Broker (Chromium): connect your port to me; the Engine pulls the Broker when it needs it. */
	wakeBroker: "oshawott:wake-broker",
} as const;
