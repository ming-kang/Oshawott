import { arr, int, method, num, obj, remote, str } from "../lib/chord.ts";
import { Described, type PageToolName, pageTools as t } from "../tools/page-tools.ts";
import { TabHost } from "./hosts.ts";

const tools = Object.fromEntries(Object.entries(t).map(([name, spec]) => [name, method(obj(spec.args), spec.result)])) as {
	[N in PageToolName]: ReturnType<typeof method<ReturnType<typeof obj<(typeof t)[N]["args"]>>, (typeof t)[N]["result"]>>;
};

const methods = {
	...tools,
	/** Not a tool: names the element an action targets, so a confirmation can say what it is. */
	describe: method(obj({ ref: str() }), Described),
	/** Not a tool: where the page is after an action and which dialogs it opened, for the action's receipt. */
	settled: method(undefined, obj({ url: str(), title: str(), opened: arr(str()) })),
	/** Not a tool: viewport metrics for page_screenshot's CSS-pixel regions. */
	viewport: method(undefined, obj({ width: num(), height: num(), dpr: num() })),
};

export const Page = remote("oshawott.page", {
	version: 3,
	params: { tabId: int() },
	hostAddress: ({ tabId }) => TabHost({ tabId }),
	variants: { engine: { methods } },
});
