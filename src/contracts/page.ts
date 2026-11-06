// One page's tools, served by the content script of tab `tabId` and used by the Engine only.
import { int, method, obj, remote } from "../lib/chord.ts";
import { type PageToolName, pageTools as t } from "../tools/page-tools.ts";
import { TabHost } from "./hosts.ts";

const methods = {
	page_snapshot: method(obj(t.page_snapshot.args), t.page_snapshot.result),
	page_click: method(obj(t.page_click.args), t.page_click.result),
	page_type: method(obj(t.page_type.args), t.page_type.result),
	page_scroll: method(obj(t.page_scroll.args), t.page_scroll.result),
} satisfies Record<PageToolName, unknown>;

export const Page = remote("oshawatt.page", {
	version: 1,
	params: { tabId: int() },
	hostAddress: ({ tabId }) => TabHost({ tabId }),
	variants: { engine: { methods } },
});
