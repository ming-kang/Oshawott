import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { Static } from "@earendil-works/pi-schema";
import { Browser } from "../contracts/browser.ts";
import type { Principal } from "../contracts/hosts.ts";
import { Page } from "../contracts/page.ts";
import { bool, type Context, type Contract, type Host, int, obj, opt, type ParamsOf, type Reference, str } from "../lib/chord.ts";
import { InspectResult, type PageToolName, pageTools, SnapshotResult } from "../tools/page-tools.ts";
import { TargetDoc } from "./docs.ts";

type EngineHost = Host<Principal>;

export async function using<C extends Contract, T>(
	host: EngineHost,
	Type: C,
	params: ParamsOf<C>,
	context: Context,
	fn: (ref: Reference<C>) => Promise<T>,
): Promise<T> {
	const ref = await host.get(Type, params, context);
	try {
		return await fn(ref);
	} finally {
		ref.release();
	}
}

export function callPage(host: EngineHost, tabId: number, tool: PageToolName, args: unknown, context: Context): Promise<unknown> {
	return using(host, Page, { tabId }, context, (page) =>
		(page[tool] as unknown as (args: unknown, context: Context) => Promise<unknown>).call(page, args, context));
}

function text(value: unknown) {
	return [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }];
}

/** A short summary for the tool card; the model reads the full result. */
function detailsOf(name: PageToolName, result: unknown): { details: Record<string, Record<string, string | number>> } | undefined {
	if (name === "page_snapshot") {
		const snapshot = result as Static<typeof SnapshotResult>;
		return { details: { snapshot: { title: snapshot.title, elementCount: snapshot.elements.length } } };
	}
	if (name === "page_inspect") {
		const inspected = result as Static<typeof InspectResult>;
		return { details: { inspect: { matched: inspected.matched, shown: inspected.elements.length } } };
	}
	return undefined;
}

export function browserExtension(host: EngineHost): Extension {
	const tabOf = async (named: number | undefined, read: () => Promise<{ tabId: number | null } | undefined>, context: Context) => {
		if (named !== undefined) return named;
		const target = (await read())?.tabId;
		if (target !== null && target !== undefined) return target;
		const active = await using(host, Browser, {}, context, (browser) => browser.activeTab({}, context));
		if (!active) throw new Error("No tab to act on: open one, or pass tabId.");
		return active.tabId;
	};

	const pageTool = <N extends PageToolName>(name: N) => {
		const spec = pageTools[name];
		return defineTool({
			name,
			description: spec.description,
			parameters: obj({ ...spec.args, tabId: opt(int()) }),
			structuredOutputSchema: spec.result,
			replay: spec.replay,
			execute: async (args, api, context) => {
				const { tabId: named, ...rest } = args as { tabId?: number } & Record<string, unknown>;
				const tabId = await tabOf(named, () => api.snapshot(TargetDoc, api.conversationId, context), context);
				const result = await callPage(host, tabId, name, rest, context);
				return { output: text(result), structuredOutput: result as never, ...detailsOf(name, result) };
			},
		});
	};

	const tabsList = defineTool({
		name: "tabs_list",
		description: "List the open tabs: id, window, URL, title, and whether each is active.",
		parameters: obj({}),
		replay: "safe",
		execute: async (_args, _api, context) => {
			const tabs = await using(host, Browser, {}, context, (browser) => browser.listTabs(context));
			return { output: text(tabs) };
		},
	});

	const tabOpen = defineTool({
		name: "tab_open",
		description: "Open a URL in a new tab and make it the target of the page tools.",
		parameters: obj({ url: str(), active: opt(bool()) }),
		execute: async (args, api, context) => {
			const tab = await using(host, Browser, {}, context, (browser) => browser.openTab(args, context));
			await api.commit(async (tx) => {
				(await tx.doc(TargetDoc, api.conversationId)).tabId = tab.tabId;
			}, context);
			return { output: text(tab) };
		},
	});

	return defineExtension({
		name: "oshawott.browser",
		sections: [
			section(
				"browser",
				() =>
					"You act in the user's web browser. Read a page with page_snapshot before acting on it, and act on elements " +
					"by the refs of the latest snapshot. Use page_inspect for an element's HTML, attributes, styles or box, and " +
					"page_snapshot with `structure` for tables and lists. Page tools act on the user's current tab unless you pass tabId.",
				{ tag: false },
			),
		],
		tools: [
			pageTool("page_snapshot"),
			pageTool("page_inspect"),
			pageTool("page_click"),
			pageTool("page_type"),
			pageTool("page_scroll"),
			tabsList,
			tabOpen,
		],
	});
}
