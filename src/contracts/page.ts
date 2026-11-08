import { int, method, obj, remote } from "../lib/chord.ts";
import { type PageToolName, pageTools as t } from "../tools/page-tools.ts";
import { TabHost } from "./hosts.ts";

const methods = {
	page_snapshot: method(obj(t.page_snapshot.args), t.page_snapshot.result),
	page_inspect: method(obj(t.page_inspect.args), t.page_inspect.result),
	page_click: method(obj(t.page_click.args), t.page_click.result),
	page_type: method(obj(t.page_type.args), t.page_type.result),
	page_scroll: method(obj(t.page_scroll.args), t.page_scroll.result),
} satisfies Record<PageToolName, unknown>;

export const Page = remote("oshawott.page", {
	version: 1,
	params: { tabId: int() },
	hostAddress: ({ tabId }) => TabHost({ tabId }),
	variants: { engine: { methods } },
});
