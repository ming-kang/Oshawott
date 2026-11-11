import { int, method, obj, remote, str } from "../lib/chord.ts";
import { Described, type PageToolName, pageTools as t } from "../tools/page-tools.ts";
import { TabHost } from "./hosts.ts";

const tools = Object.fromEntries(Object.entries(t).map(([name, spec]) => [name, method(obj(spec.args), spec.result)])) as {
	[N in PageToolName]: ReturnType<typeof method<ReturnType<typeof obj<(typeof t)[N]["args"]>>, (typeof t)[N]["result"]>>;
};

const methods = {
	...tools,
	/** Not a tool: names the element an action targets, so a confirmation can say what it is. */
	describe: method(obj({ ref: str() }), Described),
};

export const Page = remote("oshawott.page", {
	version: 2,
	params: { tabId: int() },
	hostAddress: ({ tabId }) => TabHost({ tabId }),
	variants: { engine: { methods } },
});
