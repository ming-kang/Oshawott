import { hostKind, int } from "../lib/chord.ts";

export const EngineHost = hostKind("oshawott.engine");
export const BrokerHost = hostKind("oshawott.broker");
export const TabHost = hostKind("oshawott.tab", { tabId: int() });

/** Link-authenticated caller identity; callers do not assert it themselves. */
export type Principal =
	| { readonly kind: "engine" }
	| { readonly kind: "broker" }
	| { readonly kind: "panel"; readonly instance: string }
	| { readonly kind: "tab"; readonly tabId: number };

export const PORTS = {
	broker: "oshawott:broker",
	tab: "oshawott:tab",
	panel: "oshawott:panel",
} as const;

/** One-shot messages (not links), which wake a sleeping service worker or event page. */
export const MESSAGES = {
	ensureEngine: "oshawott:ensure-engine",
	wakeBroker: "oshawott:wake-broker",
} as const;
