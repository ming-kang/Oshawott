import type { Tab } from "../contracts/browser.ts";
import type { Static } from "../lib/chord.ts";
import type { Done, InspectResult, SnapshotResult } from "./page-tools.ts";

export const TOOL_PREVIEW_CHARS = 12_000;
export const SNAPSHOT_PREVIEW_ELEMENTS = 40;

export type ToolDetails =
	| ({ kind: "page_snapshot"; elementCount: number; firstButtonRef?: string } & Pick<Static<typeof SnapshotResult>, "url" | "title" | "text" | "elements">)
	| ({ kind: "page_inspect" } & Static<typeof InspectResult>)
	| ({ kind: "page_wait" } & Pick<Static<typeof Done>, "ok" | "detail">)
	| { kind: "tab"; tab: Tab }
	| { kind: "tabs_list"; tabs: Tab[] }
	| { kind: "ls"; root: string; entries: { path: string; kind: "file" | "directory"; size: number }[]; limit?: number }
	| { kind: "write"; bytes: number }
	| { kind: "fetch"; http: { status: number; bytes: number }; headline: string; preview: string };

/** Older or third-party results do not have our discriminator. */
export function readToolDetails<K extends ToolDetails["kind"]>(value: unknown, kind: K): Extract<ToolDetails, { kind: K }> | undefined {
	return value !== null && typeof value === "object" && "kind" in value && value.kind === kind
		? value as Extract<ToolDetails, { kind: K }> : undefined;
}
