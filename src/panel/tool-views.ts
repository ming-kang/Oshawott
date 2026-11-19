import { formatBytes } from "../lib/bytes.ts";
import { hostOf } from "../platform/patterns.ts";
import { t } from "./i18n/index.ts";
import { codeBlock } from "./tool-highlight.ts";
import { h, type IconName } from "./ui.ts";

/** Model text is data, never markup. */
export interface ToolResult {
	readonly text: string;
	readonly isError: boolean;
	readonly details?: unknown;
}

/** A `body` must build safe nodes from the structured `details` (via `h`/`textContent`) and must never assign model text to `innerHTML`. */
export interface ToolView {
	readonly name?: string;
	readonly names?: readonly string[];
	readonly icon: IconName | ((args: Record<string, unknown>) => IconName);
	readonly label: string | ((args: Record<string, unknown>) => string);
	readonly argsMeta?: (args: Record<string, unknown>) => string | undefined;
	/** `argsMeta` is what the card showed while the call ran. */
	readonly resultMeta?: (details: unknown, argsMeta: string) => string | undefined;
	readonly body?: (result: ToolResult) => Node | undefined;
}

export interface ToolLook {
	icon: IconName;
	label: string;
	meta?: string;
}

const refMeta = (args: Record<string, unknown>): string => String(args.ref ?? "");
const refOrSelectorMeta = (args: Record<string, unknown>): string => String(args.ref ?? args.selector ?? "");
const pathMeta = (args: Record<string, unknown>): string => String(args.path ?? "");
const tabIdMeta = (args: Record<string, unknown>): string => String(args.tabId ?? "");
const hostMeta = (args: Record<string, unknown>): string => hostOf(args.url);

const clip = (text: string, max: number): string => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text);
const quotedTextMeta = (args: Record<string, unknown>): string => `“${clip(String(args.text ?? ""), 40)}”`;

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

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

/** The element an action touched, by its accessible name: a ref means nothing to the reader. */
const elementLabel = (details: unknown): string | undefined => {
	const element = record(record(details)?.element);
	if (!element || typeof element.role !== "string" || typeof element.name !== "string") return undefined;
	return element.name ? `${clip(element.name, 40)} (${element.role})` : element.role;
};
const elementAndInputMeta = (details: unknown, argsMeta: string): string | undefined => {
	const element = elementLabel(details);
	return element && [element, argsMeta].filter(Boolean).join(" · ");
};

const parseJsonRecord = (text: string): Record<string, unknown> | undefined => {
	try {
		return record(JSON.parse(text));
	} catch {
		return undefined;
	}
};

export interface SnapshotResultView {
	url: string;
	title: string;
	text: string;
	elements: { ref: string; role: string; name: string }[];
}

/** The `page_snapshot` result is its `SnapshotResult` serialized as JSON for the model. */
export function parseSnapshotResult(text: string): SnapshotResultView | undefined {
	const data = parseJsonRecord(text);
	if (!data || typeof data.url !== "string" || typeof data.title !== "string" || !Array.isArray(data.elements)) return undefined;
	const elements = data.elements.flatMap((entry) => {
		const element = record(entry);
		return element && typeof element.ref === "string" && typeof element.role === "string" && typeof element.name === "string"
			? [{ ref: element.ref, role: element.role, name: element.name }]
			: [];
	});
	return { url: data.url, title: data.title, text: typeof data.text === "string" ? data.text : "", elements };
}

/** The `codemode` result header from Durable's `formatResult`: status line, wall time, then the output. */
export function parseCodemodeResult(text: string): { ok: boolean; seconds: string; output: string } | undefined {
	const match = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n?([\s\S]*)$/.exec(text);
	return match ? { ok: match[1] === "completed", seconds: match[2]!, output: match[3]! } : undefined;
}

/** The `ls` result lines: `path/` for directories, `path  (N bytes)` for files, bracketed notes. */
const parseListing = (text: string): { entries: { name: string; size?: number }[]; note?: string; empty?: string } | undefined => {
	const entries: { name: string; size?: number }[] = [];
	let note: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const file = /^(.*\S)\s{2}\((\d+) bytes\)$/.exec(line);
		if (file) { entries.push({ name: file[1]!, size: Number(file[2]!) }); continue; }
		if (line.startsWith("[")) { note ??= line; continue; }
		if (/ is empty\.$/.test(line)) return { entries, note, empty: line };
		entries.push({ name: line });
	}
	return { entries, note };
};

const prettyJson = (text: string): string | undefined => {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
};

const SNAPSHOT_ELEMENTS_SHOWN = 40;

const snapshotBody = ({ text }: ToolResult): Node | undefined => {
	const snapshot = parseSnapshotResult(text);
	if (!snapshot) return undefined;
	const shown = snapshot.elements.slice(0, SNAPSHOT_ELEMENTS_SHOWN);
	return h("div", { class: "tool-view" },
		h("div", { class: "tv-title" }, snapshot.title || snapshot.url),
		snapshot.url !== snapshot.title ? h("div", { class: "tv-url" }, snapshot.url) : null,
		shown.length ? h("div", { class: "tv-rows" },
			...shown.map((element) => h("div", { class: "tv-row" },
				h("span", { class: "tv-ref" }, element.ref),
				h("span", { class: "tv-role" }, element.role),
				h("span", { class: "tv-name" }, element.name || "—"),
			)),
			snapshot.elements.length > shown.length ? h("div", { class: "tv-note" }, t("tool.more", snapshot.elements.length - shown.length)) : null,
		) : null,
		snapshot.text ? h("div", { class: "tv-text" }, snapshot.text) : null,
	);
};

const fetchBody = ({ text }: ToolResult): Node | undefined => {
	const [line = ""] = text.split("\n");
	if (!/^HTTP \d{3}\b/.test(line)) return undefined;
	const rest = text.slice(line.length).trim();
	const pretty = rest ? prettyJson(rest) : undefined;
	return h("div", { class: "tool-view" },
		h("div", { class: "tv-status" }, line),
		rest ? (pretty !== undefined ? codeBlock(pretty, "json") : h("pre", { class: "tv-preview" }, rest)) : null,
	);
};

const codemodeBody = ({ text }: ToolResult): Node | undefined => {
	const result = parseCodemodeResult(text);
	if (!result) return undefined;
	const output = result.output.trim();
	const json = prettyJson(output);
	return h("div", { class: "tool-view" },
		h("div", { class: "tv-head" },
			h("span", { class: "tv-chip", "data-tone": result.ok ? "success" : "danger" }, t(result.ok ? "tool.done" : "tool.error")),
			h("span", { class: "tv-meta" }, t("tool.wallTime", result.seconds)),
		),
		output ? (json !== undefined ? codeBlock(json, "json") : h("pre", { class: result.ok ? null : "error" }, output)) : null,
	);
};

const lsBody = ({ text }: ToolResult): Node | undefined => {
	const listing = parseListing(text);
	if (!listing || (!listing.entries.length && !listing.note && !listing.empty)) return undefined;
	return h("div", { class: "tool-view" },
		listing.empty ? h("div", { class: "tv-meta" }, listing.empty)
			: h("div", { class: "tv-rows" },
				...listing.entries.map((entry) => h("div", { class: "tv-row" },
					h("span", { class: "tv-name mono" }, entry.name),
					entry.size !== undefined ? h("span", { class: "tv-size" }, formatBytes(entry.size)) : null,
				)),
				listing.note ? h("div", { class: "tv-note" }, listing.note) : null,
			),
	);
};

const registry = new Map<string, ToolView>();

const namesOf = (view: ToolView): readonly string[] => view.names ?? (view.name === undefined ? [] : [view.name]);

export function defineToolView(view: ToolView): ToolView {
	return Object.freeze(view);
}

export function registerToolView(view: ToolView): void {
	for (const name of namesOf(view)) registry.set(name, view);
}

export function toolViewFor(name: string): ToolView | undefined {
	return registry.get(name);
}

export function resolveToolLook(name: string, args: Record<string, unknown>): ToolLook {
	const view = registry.get(name);
	if (!view) return { icon: "tool", label: name };
	const icon = typeof view.icon === "function" ? view.icon(args) : view.icon;
	const label = typeof view.label === "function" ? view.label(args) : view.label;
	const meta = view.argsMeta?.(args);
	return meta === undefined ? { icon, label } : { icon, label, meta };
}

const BUILTIN_VIEWS: readonly ToolView[] = [
	defineToolView({ name: "page_snapshot", icon: "eye", label: t("tool.snapshot"), argsMeta: refOrSelectorMeta, resultMeta: snapshotResultMeta, body: snapshotBody }),
	defineToolView({ name: "page_inspect", icon: "code", label: t("tool.inspect"), argsMeta: refOrSelectorMeta, resultMeta: inspectResultMeta }),
	defineToolView({ name: "page_click", icon: "pointer", label: t("tool.click"), argsMeta: refMeta, resultMeta: elementLabel }),
	defineToolView({ name: "page_type", icon: "keyboard", label: t("tool.type"), argsMeta: quotedTextMeta, resultMeta: elementAndInputMeta }),
	defineToolView({ name: "page_select", icon: "list", label: t("tool.select"), argsMeta: (args) => String(args.option ?? ""), resultMeta: elementAndInputMeta }),
	defineToolView({ name: "page_press", icon: "keyboard", label: t("tool.press"), argsMeta: (args) => [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key ?? ""].join("+"), resultMeta: elementAndInputMeta }),
	defineToolView({ name: "page_hover", icon: "pointer", label: t("tool.hover"), argsMeta: refMeta, resultMeta: elementLabel }),
	defineToolView({ name: "page_wait", icon: "refresh", label: t("tool.wait"), argsMeta: (args) => String(args.selector ?? args.text ?? (args.timeoutMs ? `${args.timeoutMs} ms` : "")) }),
	defineToolView({ name: "page_scroll", icon: "scroll", label: t("tool.scroll"), argsMeta: (args) => (args.ref ? String(args.ref) : args.pixels ? `${args.pixels}px` : ""), resultMeta: elementLabel }),
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
	defineToolView({ name: "codemode", icon: "code", label: t("tool.code"), body: codemodeBody }),
	defineToolView({ names: ["read", "read_text"], icon: "file", label: t("tool.read"), argsMeta: pathMeta }),
	defineToolView({ name: "write", icon: "file", label: t("tool.write"), argsMeta: pathMeta }),
	defineToolView({ name: "edit", icon: "compose", label: t("tool.edit"), argsMeta: pathMeta }),
	defineToolView({ name: "ls", icon: "folder", label: t("tool.ls"), argsMeta: (args) => String(args.path ?? "/workspace"), body: lsBody }),
	defineToolView({ name: "fetch", icon: "download", label: t("tool.fetch"), argsMeta: hostMeta, resultMeta: fetchResultMeta, body: fetchBody }),
];

for (const view of BUILTIN_VIEWS) registerToolView(view);
