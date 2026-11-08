import { Page } from "../contracts/page.ts";
import { PORTS, type Principal, TabHost } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost, defineFacet } from "../lib/chord.ts";
import { type PortLink, portLink } from "../link/port-link.ts";
import { ext } from "../platform/webext.ts";
import { click, inspect, scroll, snapshot, type } from "./dom.ts";

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
								page_inspect: async (args) => inspect(args),
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
	let link: PortLink | undefined;
	const connect = () => {
		link?.close();
		const port = ext.runtime.connect({ name: PORTS.tab });
		link = portLink(port, () => ext.runtime.lastError?.message);
		host.accept(link, { principal: { kind: "engine" } }, context);
	};
	// A document entering the back-forward cache is frozen but, in Firefox, keeps its port: the Engine would keep calling
	// it until the link times out. Closing it routes the next call to the tab's current document; if this one comes
	// back, the Engine's next attach reconnects it.
	addEventListener("pagehide", (event) => {
		if (event.persisted) link?.close();
	});
	globalThis.__oshawottPage = { connect };
	connect();
}

if (globalThis.__oshawottPage) globalThis.__oshawottPage.connect();
else if (typeof globalThis.__oshawottTabId === "number") void start(globalThis.__oshawottTabId);
