// Page tools, declared once. Each spec is the single source for three things:
// - the `Page` contract's method (arguments and result, checked by Chord at the page's host),
// - the Durable tool the model calls (its parameters are the arguments plus an optional `tabId`),
// - the replay policy: whether a call cut off by a restart may run again (`safe`: reads; `unsafe`: anything that acts).
//
// The framework never sends an action twice: Durable records a call's intent before `execute()`, and a call cut off by
// a restart or a navigation reruns only when it is `safe`; otherwise the model gets an `interrupted` result.
import type { Properties, StaticObject } from "@earendil-works/pi-schema";
import { arr, bool, int, obj, opt, type Schema, str } from "../lib/chord.ts";

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

export const SnapshotResult = obj({
	url: str(),
	title: str(),
	text: str(),
	truncated: bool(),
	elements: arr(Element),
});

const Done = obj({ ok: bool(), detail: opt(str()) });

export const pageTools = {
	page_snapshot: spec({
		description:
			"Read the page: its URL, title, visible text, and the interactive elements with a `ref` each. " +
			"Refs stay valid until the next snapshot or a navigation.",
		args: { maxChars: opt(int({ min: 200, max: 200_000 })) },
		result: SnapshotResult,
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

/** The arguments of a page tool, as its implementation receives them. */
export type PageToolArgs<N extends PageToolName> = StaticObject<(typeof pageTools)[N]["args"]>;
