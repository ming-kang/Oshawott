// Durable records intent before execute(): after an interruption, only `safe` calls replay.
import type { Properties, StaticObject } from "@earendil-works/pi-schema";
import { arr, bool, int, map, num, obj, oneOf, opt, type Schema, str } from "../lib/chord.ts";
import { LIMITS } from "../page/limits.ts";

export interface PageToolSpec<A extends Properties = Properties, R extends Schema = Schema> {
	readonly description: string;
	readonly args: A;
	readonly result: R;
	readonly replay: "safe" | "unsafe";
}

function spec<const A extends Properties, R extends Schema>(tool: PageToolSpec<A, R>): PageToolSpec<A, R> {
	return tool;
}

const Element = obj({
	ref: str(),
	role: str(),
	name: str(),
});

const Table = obj({
	ref: str(),
	caption: opt(str()),
	headers: arr(str()),
	rows: arr(arr(str())),
	truncated: bool(),
});

const List = obj({
	ref: str(),
	kind: oneOf("ul", "ol", "dl"),
	items: arr(str()),
	truncated: bool(),
});

export const Structure = obj({ tables: arr(Table), lists: arr(List), truncated: bool() });

export const SnapshotResult = obj({
	url: str(),
	title: str(),
	text: str(),
	truncated: bool(),
	elements: arr(Element),
	structure: opt(Structure),
});

export const INSPECT_PARTS = ["html", "attributes", "styles", "box"] as const;

const Inspected = obj({
	ref: str(),
	tag: str(),
	visible: bool(),
	/** Some HTML, attributes or attribute values were cut to the limits. */
	truncated: bool(),
	attributes: opt(map(str())),
	box: opt(obj({ x: num(), y: num(), width: num(), height: num(), inViewport: bool() })),
	styles: opt(map(str())),
	html: opt(str()),
});

export const InspectResult = obj({
	url: str(),
	matched: int(),
	truncated: bool(),
	elements: arr(Inspected),
});

const Done = obj({ ok: bool(), detail: opt(str()) });

export const pageTools = {
	page_snapshot: spec({
		description:
			"Read the page: its URL, title, visible text, and the interactive elements with a `ref` each. " +
			"Refs stay valid until the next snapshot or a navigation. `ref` or `selector` (its first match) limits the " +
			"snapshot to that element's subtree; `structure` adds the visible tables and lists as data. A selector that " +
			"matches nothing is an error.",
		args: {
			maxChars: opt(int({ min: 200, max: 200_000 })),
			ref: opt(str()),
			selector: opt(str()),
			structure: opt(bool()),
		},
		result: SnapshotResult,
		replay: "safe",
	}),
	page_inspect: spec({
		description:
			"Inspect elements by a `ref` from the latest snapshot or by a CSS `selector`: their outer HTML, attributes, " +
			"computed styles and bounding box. `include` picks parts (default all); `styles` names CSS properties (default " +
			"common layout and visibility ones). Each element gets a `ref` usable by the other page tools. A selector that " +
			"matches nothing is an error.",
		args: {
			ref: opt(str()),
			selector: opt(str()),
			include: opt(arr(oneOf(...INSPECT_PARTS), { min: 1 })),
			styles: opt(arr(str({ max: 64 }), { min: 1, max: 40 })),
			maxElements: opt(int({ min: 1, max: LIMITS.inspectElementsMax })),
			maxHtml: opt(int({ min: 100, max: LIMITS.htmlMax })),
		},
		result: InspectResult,
		replay: "safe",
	}),
	page_click: spec({
		description: "Click the element with this `ref` from the last snapshot.",
		args: { ref: str() },
		result: Done,
		replay: "unsafe",
	}),
	page_type: spec({
		description: "Type text into the input with this `ref`, replacing its value; `submit` presses Enter after it.",
		args: { ref: str(), text: str(), submit: opt(bool()) },
		result: Done,
		replay: "unsafe",
	}),
	page_scroll: spec({
		description: "Scroll the element with this `ref` into view, or the page by `pixels` (negative scrolls up).",
		args: { ref: opt(str()), pixels: opt(int()) },
		result: Done,
		replay: "safe",
	}),
} as const;

export type PageToolName = keyof typeof pageTools;

export type PageToolArgs<N extends PageToolName> = StaticObject<(typeof pageTools)[N]["args"]>;
