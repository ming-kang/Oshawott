// The content script of one tab, injected on demand by the Broker (never declared for every site). It serves `Page`
// at `TabHost({ tabId })` and connects a Port to the Engine, which accepts nothing on it: the Engine is this host's
// child, holding its tools. When the port drops (the Engine's document went away), the script only waits: the Engine
// injects again when it needs the tab, and a second injection reconnects instead of starting a second host.
import { Page } from "../contracts/page.ts";
import { PORTS, type Principal, TabHost } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet } from "../lib/chord.ts";
import { portLink } from "../link/port-link.ts";
import { ext } from "../platform/webext.ts";
import { click, scroll, snapshot, type } from "./dom.ts";

declare global {
	// Set by the Broker's first injection step, read here: a content script cannot learn its tab id by itself.
	var __oshawottTabId: number | undefined;
	var __oshawottPage: { connect(): void } | undefined;
}

const context = BACKGROUND_CONTEXT;

async function start(tabId: number) {
	const host = createHost<Principal>({
		address: TabHost({ tabId }),
		principal: { kind: "tab", tabId },
		onError: (error) => console.debug("[oshawott page]", error),
	});
	await host.load(
		[
			{
				name: "oshawott.page",
				facet: defineFacet<Principal>((self) => {
					self.serve(Page, (_params, principal) => {
						if (principal.kind !== "engine") throw new Error("Only the Engine uses page tools.");
						return {
							variant: "engine",
							members: {
								page_snapshot: async (args) => snapshot(args),
								page_click: async (args) => click(args),
								page_type: async (args) => type(args),
								page_scroll: async (args) => scroll(args),
							},
						};
					});
				}),
			},
		],
		context,
	);
	const connect = () => {
		const port = ext.runtime.connect({ name: PORTS.tab });
		host.accept(portLink(port, () => ext.runtime.lastError?.message), { principal: { kind: "engine" } }, context);
	};
	globalThis.__oshawottPage = { connect };
	connect();
}

if (globalThis.__oshawottPage) globalThis.__oshawottPage.connect();
else if (typeof globalThis.__oshawottTabId === "number") void start(globalThis.__oshawottTabId);
