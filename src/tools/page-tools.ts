// Durable records intent before execute(): after an interruption, only `safe` calls replay.
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

export type PageToolArgs<N extends PageToolName> = StaticObject<(typeof pageTools)[N]["args"]>;
