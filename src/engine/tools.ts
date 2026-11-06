// The tools the model calls, as one Durable extension. Page tools are generated from their specs and reach the page
// over Chord (`Page` at `TabHost({ tabId })`); browser tools reach the Broker (`Browser`). A tool holds a reference only
// for its call: the route keeps the link to a tab while it is open, so the next call is not resolved again.
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { Browser } from "../contracts/browser.ts";
import type { Principal } from "../contracts/hosts.ts";
import { Page } from "../contracts/page.ts";
import { bool, type Context, type Contract, type Host, int, obj, opt, type ParamsOf, type Reference, str } from "../lib/chord.ts";
import { type PageToolName, pageTools } from "../tools/page-tools.ts";
import { TargetDoc } from "./docs.ts";

type EngineHost = Host<Principal>;

/** Runs `fn` with a reference that is released when it settles. */
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

function text(value: unknown) {
	return [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }];
}

export function browserExtension(host: EngineHost): Extension {
	/** The call's tab: named, else the conversation's target, else the active tab. */
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
				const result = await using(host, Page, { tabId }, context, (page) => {
					const call = page[name] as unknown as (args: unknown, context: Context) => Promise<unknown>;
					return call.call(page, rest, context);
				});
				return { output: text(result), structuredOutput: result as never };
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
		name: "oshawatt.browser",
		sections: [
			section(
				"browser",
				() =>
					"You act in the user's web browser. Read a page with page_snapshot before acting on it, and act on elements " +
					"by the refs of the latest snapshot. Page tools act on the user's current tab unless you pass tabId.",
				{ tag: false },
			),
		],
		tools: [
			pageTool("page_snapshot"),
			pageTool("page_click"),
			pageTool("page_type"),
			pageTool("page_scroll"),
			tabsList,
			tabOpen,
		],
	});
}
