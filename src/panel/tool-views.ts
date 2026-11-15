import { formatBytes } from "../lib/bytes.ts";
import { hostOf } from "../platform/patterns.ts";
import { t } from "./i18n/index.ts";
import type { IconName } from "./ui.ts";

/** A settled tool result handed to a view's rich-body hook. Model text is data, never markup. */
export interface ToolResult {
	readonly text: string;
	readonly isError: boolean;
	readonly details?: unknown;
}

/**
 * How one tool — or a coherent family sharing a name list — reads in the panel.
 *
 * `icon` and `label` may be fixed or vary with the arguments; `argsMeta` and `resultMeta` are
 * optional header summaries; `body` is an opt-in rich rendering of a successful result. A `body`
 * must build safe nodes from the structured `details` (via `h`/`textContent`) and must never assign
 * model text to `innerHTML`.
 */
export interface ToolView {
	/** A single tool name, or several names that share this view (a coherent family). */
	readonly name?: string;
	readonly names?: readonly string[];
	readonly icon: IconName | ((args: Record<string, unknown>) => IconName);
	readonly label: string | ((args: Record<string, unknown>) => string);
	/** The argument summary shown in the header while the call streams and runs. */
	readonly argsMeta?: (args: Record<string, unknown>) => string | undefined;
	/** The result summary shown in the header once the call settles, read from structured details. */
	readonly resultMeta?: (details: unknown) => string | undefined;
	/** Opt-in rich result body for a successful call; build safe nodes, never model text as HTML. */
	readonly body?: (result: ToolResult) => Node | undefined;
}

/** A tool call's header: its icon, label and argument summary line. */
export interface ToolLook {
	icon: IconName;
	label: string;
	meta?: string;
}

// Reusable argument summaries: the composable pieces a view's `argsMeta` can share.
const refMeta = (args: Record<string, unknown>): string => String(args.ref ?? "");
const refOrSelectorMeta = (args: Record<string, unknown>): string => String(args.ref ?? args.selector ?? "");
const pathMeta = (args: Record<string, unknown>): string => String(args.path ?? "");
const tabIdMeta = (args: Record<string, unknown>): string => String(args.tabId ?? "");
const hostMeta = (args: Record<string, unknown>): string => hostOf(args.url);

const clip = (text: string, max: number): string => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text);
const quotedTextMeta = (args: Record<string, unknown>): string => `“${clip(String(args.text ?? ""), 40)}”`;

/** Narrows an unknown value to a plain object, or undefined; shared with the card's access check. */
export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

// Result summaries, per tool that reports structured `details`.
const fetchResultMeta = (details: unknown): string | undefined => {
	const http = record(record(details)?.http);
	return http && count(http.status) && http.status >= 100 && http.status <= 599 && count(http.bytes)
		? `HTTP ${http.status} · ${formatBytes(http.bytes)}` : undefined;
};

const snapshotResultMeta = (details: unknown): string | undefined => {
	const snapshot = record(record(details)?.snapshot);
	if (snapshot && typeof snapshot.title === "string" && count(snapshot.elementCount)) {
		return [snapshot.title, t("tool.elements", snapshot.elementCount)].filter(Boolean).join(" · ");
	}
	return undefined;
};

const inspectResultMeta = (details: unknown): string | undefined => {
	const inspect = record(record(details)?.inspect);
	if (inspect && count(inspect.matched) && count(inspect.shown)) {
		return inspect.shown < inspect.matched ? t("tool.inspected", inspect.shown, inspect.matched) : t("tool.elements", inspect.matched);
	}
	return undefined;
};

// The registry, keyed by tool name: registering the same name again overwrites, never duplicates.
const registry = new Map<string, ToolView>();

const namesOf = (view: ToolView): readonly string[] => view.names ?? (view.name === undefined ? [] : [view.name]);

/** Declares a view as an immutable definition. The seam for composing shared summaries. */
export function defineToolView(view: ToolView): ToolView {
	return Object.freeze(view);
}

/**
 * Registers a view under each of its tool names. Idempotent by name, so re-registration under a
 * hot reload or repeated test setup replaces rather than accumulates.
 */
export function registerToolView(view: ToolView): void {
	for (const name of namesOf(view)) registry.set(name, view);
}

/** The registered view for a tool, or undefined for an unknown tool. */
export function toolViewFor(name: string): ToolView | undefined {
	return registry.get(name);
}

/** Resolves a call's header. Unknown tools fall back to their raw name with the generic icon. */
export function resolveToolLook(name: string, args: Record<string, unknown>): ToolLook {
	const view = registry.get(name);
	if (!view) return { icon: "tool", label: name };
	const icon = typeof view.icon === "function" ? view.icon(args) : view.icon;
	const label = typeof view.label === "function" ? view.label(args) : view.label;
	const meta = view.argsMeta?.(args);
	return meta === undefined ? { icon, label } : { icon, label, meta };
}

// The built-in views: one definition per tool, or per coherent family (read / read_text).
const BUILTIN_VIEWS: readonly ToolView[] = [
	defineToolView({ name: "page_snapshot", icon: "eye", label: t("tool.snapshot"), argsMeta: refOrSelectorMeta, resultMeta: snapshotResultMeta }),
	defineToolView({ name: "page_inspect", icon: "code", label: t("tool.inspect"), argsMeta: refOrSelectorMeta, resultMeta: inspectResultMeta }),
	defineToolView({ name: "page_click", icon: "pointer", label: t("tool.click"), argsMeta: refMeta }),
	defineToolView({ name: "page_type", icon: "keyboard", label: t("tool.type"), argsMeta: quotedTextMeta }),
	defineToolView({ name: "page_select", icon: "list", label: t("tool.select"), argsMeta: (args) => String(args.option ?? "") }),
	defineToolView({ name: "page_press", icon: "keyboard", label: t("tool.press"), argsMeta: (args) => [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key ?? ""].join("+") }),
	defineToolView({ name: "page_hover", icon: "pointer", label: t("tool.hover"), argsMeta: refMeta }),
	defineToolView({ name: "page_wait", icon: "refresh", label: t("tool.wait"), argsMeta: (args) => String(args.selector ?? args.text ?? (args.timeoutMs ? `${args.timeoutMs} ms` : "")) }),
	defineToolView({ name: "page_scroll", icon: "scroll", label: t("tool.scroll"), argsMeta: (args) => (args.ref ? String(args.ref) : args.pixels ? `${args.pixels}px` : "") }),
	defineToolView({ name: "tabs_list", icon: "tabs", label: t("tool.tabs") }),
	defineToolView({ name: "tab_open", icon: "external", label: t("tool.open"), argsMeta: hostMeta }),
	defineToolView({
		name: "tab_navigate",
		icon: (args) => (args.back ? "back" : "globe"),
		label: (args) => t(args.back ? "tool.back" : "tool.navigate"),
		argsMeta: (args) => (args.back ? "" : hostOf(args.url)),
	}),
	defineToolView({ name: "tab_activate", icon: "tabs", label: t("tool.activate"), argsMeta: tabIdMeta }),
	defineToolView({ name: "tab_close", icon: "x", label: t("tool.close"), argsMeta: tabIdMeta }),
	defineToolView({ name: "codemode", icon: "code", label: t("tool.code") }),
	defineToolView({ names: ["read", "read_text"], icon: "file", label: t("tool.read"), argsMeta: pathMeta }),
	defineToolView({ name: "write", icon: "file", label: t("tool.write"), argsMeta: pathMeta }),
	defineToolView({ name: "edit", icon: "compose", label: t("tool.edit"), argsMeta: pathMeta }),
	defineToolView({ name: "ls", icon: "folder", label: t("tool.ls"), argsMeta: (args) => String(args.path ?? "/workspace") }),
	defineToolView({ name: "fetch", icon: "download", label: t("tool.fetch"), argsMeta: hostMeta, resultMeta: fetchResultMeta }),
];

for (const view of BUILTIN_VIEWS) registerToolView(view);
