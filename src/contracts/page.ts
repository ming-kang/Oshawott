import type { Properties } from "@earendil-works/pi-schema";
import { arr, bool, bytes, int, method, nul, num, obj, opt, remote, type Schema, type Static, str, union } from "../lib/chord.ts";
import { Described, Done, Element, type PageToolSpec, pageTools as t } from "../tools/page-tools.ts";
import { MAX_FILE_BYTES } from "./chat.ts";
import { TabHost } from "./hosts.ts";

/** The tab link's parts carry page_upload's files: the file cap plus the call around them. */
export const PAGE_LINK_LIMITS = { part: 32 * 1024 * 1024, decoded: 64 * 1024 * 1024 } as const;

const receiptArgs = { receiptId: opt(str()) };
const action = <A extends Properties, R extends Schema>(spec: PageToolSpec<A, R>) =>
	method(obj({ ...spec.args, ...receiptArgs }), spec.result);

const uploadArgs = {
	ref: str(),
	files: arr(obj({ name: str(), type: str(), data: bytes({ max: MAX_FILE_BYTES }) }), { min: 1, max: 10 }),
};
const UploadArgs = obj(uploadArgs);
export type UploadArgs = Static<typeof UploadArgs>;

const methods = {
	page_snapshot: method(obj(t.page_snapshot.args), t.page_snapshot.result),
	page_inspect: method(obj(t.page_inspect.args), t.page_inspect.result),
	page_click: action(t.page_click),
	page_type: action(t.page_type),
	page_select: action(t.page_select),
	page_press: action(t.page_press),
	page_hover: action(t.page_hover),
	page_scroll: method(obj(t.page_scroll.args), t.page_scroll.result),
	page_wait: method(obj(t.page_wait.args), t.page_wait.result),
	/** Not a tool: names the element an action targets — by ref, or at a viewport point — so a confirmation can say what it is. */
	describe: method(obj({ ref: opt(str()), x: opt(num()), y: opt(num()) }), Described),
	/** Not a tool: what the page did during an action — where it is, what it opened, what appeared, what the target became. */
	settled: method(obj({ receiptId: str(), ref: opt(str()) }), union([obj({
		url: str(),
		title: str(),
		opened: arr(str()),
		appeared: arr(Element),
		appearedMore: bool(),
		target: opt(Element),
		targetGone: opt(bool()),
	}), nul()])),
	/** Not a tool: viewport metrics for page_screenshot's CSS-pixel regions. */
	viewport: method(undefined, obj({ width: num(), height: num(), dpr: num() })),
	/** Not a tool: page_upload's files, which a page tool's JSON args could not carry. */
	upload: method(obj({ ...uploadArgs, ...receiptArgs }), Done),
};

export const Page = remote("oshawott.page", {
	version: 6,
	params: { tabId: int() },
	hostAddress: ({ tabId }) => TabHost({ tabId }),
	variants: { engine: { methods } },
});
