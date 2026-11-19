import { arr, bool, bytes, int, method, num, obj, opt, remote, type Static, str } from "../lib/chord.ts";
import { Described, Done, Element, type PageToolName, pageTools as t } from "../tools/page-tools.ts";
import { MAX_FILE_BYTES } from "./chat.ts";
import { TabHost } from "./hosts.ts";

/** The tab link's parts carry page_upload's files: the file cap plus the call around them. */
export const PAGE_LINK_LIMITS = { part: 32 * 1024 * 1024, decoded: 64 * 1024 * 1024 } as const;

const tools = Object.fromEntries(Object.entries(t).map(([name, spec]) => [name, method(obj(spec.args), spec.result)])) as {
	[N in PageToolName]: ReturnType<typeof method<ReturnType<typeof obj<(typeof t)[N]["args"]>>, (typeof t)[N]["result"]>>;
};

const UploadArgs = obj({
	ref: str(),
	files: arr(obj({ name: str(), type: str(), data: bytes({ max: MAX_FILE_BYTES }) }), { min: 1, max: 10 }),
});
export type UploadArgs = Static<typeof UploadArgs>;

const methods = {
	...tools,
	/** Not a tool: names the element an action targets — by ref, or at a viewport point — so a confirmation can say what it is. */
	describe: method(obj({ ref: opt(str()), x: opt(num()), y: opt(num()) }), Described),
	/** Not a tool: what the page did during an action — where it is, what it opened, what appeared, what the target became. */
	settled: method(obj({ ref: opt(str()) }), obj({
		url: str(),
		title: str(),
		opened: arr(str()),
		appeared: arr(Element),
		appearedMore: bool(),
		target: opt(Element),
		targetGone: opt(bool()),
	})),
	/** Not a tool: viewport metrics for page_screenshot's CSS-pixel regions. */
	viewport: method(undefined, obj({ width: num(), height: num(), dpr: num() })),
	/** Not a tool: page_upload's files, which a page tool's JSON args could not carry. */
	upload: method(UploadArgs, Done),
};

export const Page = remote("oshawott.page", {
	version: 5,
	params: { tabId: int() },
	hostAddress: ({ tabId }) => TabHost({ tabId }),
	variants: { engine: { methods } },
});
