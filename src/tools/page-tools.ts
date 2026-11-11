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
	/** State, present only when it applies: a field's text (never a password), a checkbox's tick, a link's target. */
	value: opt(str()),
	checked: opt(bool()),
	disabled: opt(bool()),
	expanded: opt(bool()),
	href: opt(str()),
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

export const MODIFIERS = ["Alt", "Control", "Meta", "Shift"] as const;
export const WAIT = { default: 5_000, max: 30_000 } as const;

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
		description:
			"Click the element with this `ref`, as a pointer would: it is scrolled into view, pressed and released. " +
			"Use it for buttons, links, checkboxes, radios, tabs and menu items; take a new snapshot afterwards to see the effect.",
		args: { ref: str() },
		result: Done,
		replay: "unsafe",
	}),
	page_type: spec({
		description:
			"Type text into the text field or editable element with this `ref`, replacing its content; `submit` presses " +
			"Enter after it. Not for dropdowns (page_select) or checkboxes (page_click).",
		args: { ref: str(), text: str(), submit: opt(bool()) },
		result: Done,
		replay: "unsafe",
	}),
	page_select: spec({
		description: "Choose an option of the `<select>` with this `ref`, by the option's visible label or its value.",
		args: { ref: str(), option: str() },
		result: Done,
		replay: "unsafe",
	}),
	page_press: spec({
		description:
			"Press a key (Enter, Escape, Tab, ArrowDown, a letter…) on the element with this `ref`, or on the focused " +
			"element. Enter submits a field's form and activates a button or link. It sends key events to the page: it " +
			"does not type text (page_type) and cannot trigger browser shortcuts.",
		args: { key: str({ min: 1, max: 32 }), ref: opt(str()), modifiers: opt(arr(oneOf(...MODIFIERS), { max: MODIFIERS.length })) },
		result: Done,
		replay: "unsafe",
	}),
	page_hover: spec({
		description: "Move the pointer over the element with this `ref`, to open a hover menu or tooltip.",
		args: { ref: str() },
		result: Done,
		replay: "safe",
	}),
	page_scroll: spec({
		description: "Scroll the element with this `ref` into view, or the page by `pixels` (negative scrolls up).",
		args: { ref: opt(str()), pixels: opt(int()) },
		result: Done,
		replay: "safe",
	}),
	page_wait: spec({
		description:
			"Wait until a visible element matches `selector` or the page shows `text` (`gone`: until it no longer does), " +
			`at most \`timeoutMs\` (default ${WAIT.default}, max ${WAIT.max}). With neither, just waits that long. ` +
			"`ok` is false when the time ran out. Use it after an action whose result loads later.",
		args: {
			selector: opt(str()),
			text: opt(str({ min: 1 })),
			gone: opt(bool()),
			timeoutMs: opt(int({ min: 0, max: WAIT.max })),
		},
		result: Done,
		replay: "safe",
	}),
} as const;

export type PageToolName = keyof typeof pageTools;

/** What a page action is about to act on, for a confirmation the user reads. */
export const Described = obj({ role: str(), name: str() });

export type PageToolArgs<N extends PageToolName> = StaticObject<(typeof pageTools)[N]["args"]>;
