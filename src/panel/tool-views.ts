import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import { formatBytes } from "../lib/bytes.ts";
import { hostOf } from "../platform/patterns.ts";
import { type ParsedSnapshot, parseSnapshot } from "../tools/render.ts";
import { languageForPath } from "./file-preview.ts";
import { t } from "./i18n/index.ts";
import { codeBlock } from "./tool-highlight.ts";
import { h, type IconName } from "./ui.ts";

/** Model text is data, never markup. */
export interface ToolResult {
	readonly text: string;
	readonly isError: boolean;
	readonly details?: unknown;
	readonly diagnostics?: readonly ToolDiagnostic[];
}

export interface ToolBodyView {
	readonly label?: string;
	readonly content: Node;
	readonly copyText?: string;
}

/** A `body` must build safe nodes from `args` and `result` (via `h`/`textContent`) and must never assign model text to `innerHTML`. */
export interface ToolView {
	readonly name?: string;
	readonly names?: readonly string[];
	readonly icon: IconName | ((args: Record<string, unknown>) => IconName);
	readonly label: string | ((args: Record<string, unknown>) => string);
	readonly argsMeta?: (args: Record<string, unknown>) => string | undefined;
	/** `argsMeta` is what the card showed while the call ran. */
	readonly resultMeta?: (details: unknown, argsMeta: string, result?: ToolResult) => string | undefined;
	readonly body?: (args: Record<string, unknown>, result?: ToolResult) => ToolBodyView | undefined;
}

export interface ToolLook {
	icon: IconName;
	label: string;
	meta?: string;
}

const MAX_SHOWN = 12_000;
const SNAPSHOT_ELEMENTS_SHOWN = 40;

const clip = (text: string, max: number): string => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text);
const clampedText = (text: string): string => (text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}\n…` : text);
const refMeta = (args: Record<string, unknown>): string => String(args.ref ?? "");
const refOrSelectorMeta = (args: Record<string, unknown>): string => String(args.ref ?? args.selector ?? "");
const pathMeta = (args: Record<string, unknown>): string => String(args.path ?? "");
const tabIdMeta = (args: Record<string, unknown>): string => (args.tabId !== undefined ? `#${args.tabId}` : "");
const quotedTextMeta = (args: Record<string, unknown>): string => `“${clip(String(args.text ?? ""), 40)}”`;

function hostPathOf(url: unknown): string {
	const raw = String(url ?? "");
	try {
		const parsed = new URL(raw);
		const suffix = parsed.pathname === "/" && !parsed.search ? "" : `${parsed.pathname}${parsed.search}`;
		return clip(`${parsed.host}${suffix}`, 44);
	} catch {
		return hostOf(url);
	}
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const fetchStatusMeta = (details: unknown): string | undefined => {
	const http = record(record(details)?.http);
	return http && count(http.status) && http.status >= 100 && http.status <= 599 && count(http.bytes)
		? `HTTP ${http.status} · ${formatBytes(http.bytes)}` : undefined;
};

const fetchResultMeta = (details: unknown, argsMeta: string): string | undefined => {
	const status = fetchStatusMeta(details);
	if (!status) return undefined;
	return [argsMeta, status].filter(Boolean).join(" · ");
};

const snapshotResultMeta = (details: unknown): string | undefined => {
	const snapshot = record(record(details)?.snapshot);
	if (snapshot && typeof snapshot.title === "string" && count(snapshot.elementCount)) {
		return [snapshot.title, t("tool.elements", snapshot.elementCount)].filter(Boolean).join(" · ");
	}
	return undefined;
};

const inspectResultMeta = (details: unknown, argsMeta: string): string | undefined => {
	const inspect = record(record(details)?.inspect);
	if (inspect && count(inspect.matched) && count(inspect.shown)) {
		const counts = inspect.shown < inspect.matched ? t("tool.inspected", inspect.shown, inspect.matched) : t("tool.elements", inspect.matched);
		return [argsMeta, counts].filter(Boolean).join(" · ");
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

const parseJsonArray = (text: string): unknown[] | undefined => {
	try {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
};

const prettyJson = (text: string): string | undefined => {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return undefined;
	}
};

export type SnapshotResultView = ParsedSnapshot;
export const parseSnapshotResult = parseSnapshot;

/** The `codemode` result header from Durable's `formatResult`: status line, wall time, then the output. */
export function parseCodemodeResult(text: string): { ok: boolean; seconds: string; output: string } | undefined {
	const match = /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n?([\s\S]*)$/.exec(text);
	return match ? { ok: match[1] === "completed", seconds: match[2]!, output: match[3]! } : undefined;
}

/** The `ls` result lines: `path/` for directories, `path  (N bytes)` for files, bracketed notes. */
const parseListing = (text: string): { entries: { name: string; size?: number; directory: boolean }[]; note?: string; empty?: string } | undefined => {
	const entries: { name: string; size?: number; directory: boolean }[] = [];
	let note: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const file = /^(.*\S)\s{2}\((\d+) bytes\)$/.exec(line);
		if (file) { entries.push({ name: file[1]!, size: Number(file[2]!), directory: false }); continue; }
		if (line.startsWith("[")) { note ??= line; continue; }
		if (/ is empty\.$/.test(line)) return { entries, note, empty: line };
		entries.push({ name: line, directory: line.endsWith("/") });
	}
	return { entries, note };
};

function kvRows(rows: readonly (readonly [string, Node | string | undefined, boolean?])[]): HTMLElement | undefined {
	const present = rows.filter((row): row is readonly [string, Node | string, boolean?] => row[1] !== undefined && row[1] !== "");
	if (!present.length) return undefined;
	return h("div", { class: "tv-kv" }, ...present.map(([key, value, mono]) =>
		h("div", { class: "tv-kv-row" },
			h("span", { class: "tv-kv-key" }, key),
			h("span", { class: mono ? "tv-kv-val mono" : "tv-kv-val" }, value),
		),
	));
}

function keycaps(args: Record<string, unknown>): Node | undefined {
	const parts = [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key ?? ""].map(String).filter(Boolean);
	if (!parts.length) return undefined;
	const nodes: Node[] = [];
	for (const [index, part] of parts.entries()) {
		if (index > 0) nodes.push(h("span", { class: "tv-kbd-sep" }, "+"));
		nodes.push(h("kbd", { class: "tv-kbd" }, part));
	}
	return h("span", { class: "tv-kbd-group" }, ...nodes);
}

function withError(content: Node | undefined, result: ToolResult | undefined): Node | undefined {
	if (!result?.isError) return content;
	const errorPre = h("pre", { class: "tool-raw-pre error" }, clampedText(result.text));
	if (!content) return errorPre;
	return h("div", { class: "tv-stack" }, content, h("div", { class: "tool-divider" }), errorPre);
}

const snapshotBody = (_args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	if (!result || result.isError) return undefined;
	const snapshot = parseSnapshotResult(result.text);
	if (!snapshot) return undefined;
	const shown = snapshot.elements.slice(0, SNAPSHOT_ELEMENTS_SHOWN);
	const content = h("div", { class: "tool-view" },
		snapshot.title ? h("div", { class: "tv-title" }, snapshot.title) : null,
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
	return { label: snapshot.url || undefined, content, copyText: result.text };
};

/** One block per element in the `page_inspect` result's compact text; blocks are separated by a blank line. */
const inspectBody = (_args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	if (!result || result.isError) return undefined;
	const blocks = result.text.split("\n\n");
	const header = blocks[0]?.split("\n") ?? [];
	if (!header[0]?.startsWith("URL: ") || !header[1]?.startsWith("Matched: ")) return undefined;
	const elements = blocks.slice(1).flatMap((block) => {
		const lines = block.split("\n");
		const head = /^\[([^\]]+)\] (\S+) (visible|hidden)$/.exec(lines[0] ?? "");
		if (!head) return [];
		const section = (name: string, join: string) => {
			const at = lines.indexOf(name);
			if (at < 0) return undefined;
			const items: string[] = [];
			for (const line of lines.slice(at + 1)) {
				if (!line.startsWith("  ")) break;
				items.push(line.trim());
			}
			return items.length ? items.join(join) : undefined;
		};
		const boxText = lines.find((line) => line.startsWith("Box: "))?.slice(5);
		const htmlAt = lines.findIndex((line) => line.startsWith("HTML — "));
		const html = htmlAt < 0 ? undefined : lines.slice(htmlAt + 1).filter((line) => line !== "[Truncated.]").join("\n");
		return [h("div", { class: "tv-inspect-item" },
			h("div", { class: "tv-head" },
				h("span", { class: "tv-tag" }, `<${head[2]}>`),
				h("span", { class: "tv-ref" }, head[1]),
				head[3] === "hidden" ? h("span", { class: "tv-chip" }, t("tool.hidden")) : null,
				boxText ? h("span", { class: "tv-meta mono" }, boxText) : null,
			),
			kvRows([["attr", section("Attributes:", " "), true], ["style", section("Styles:", "; "), true]]),
			html ? codeBlock(clampedText(html), "xml", "tool-code") : null,
		)];
	});
	if (!elements.length) return undefined;
	return {
		label: header[0].slice(5),
		content: h("div", { class: "tool-view tv-inspect" }, ...elements),
		copyText: result.text,
	};
};

const fetchBody = (args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	const url = typeof args.url === "string" ? args.url : "";
	const method = typeof args.method === "string" ? args.method : "GET";
	const saveTo = typeof args.saveTo === "string" ? args.saveTo : undefined;
	if (!result) {
		const kv = kvRows([[method, url || undefined, true], ["saveTo", saveTo, true]]);
		return kv ? { label: hostPathOf(url) || undefined, content: h("div", { class: "tool-view" }, kv), copyText: url } : undefined;
	}
	if (result.isError) {
		const kv = kvRows([[method, url || undefined, true], ["saveTo", saveTo, true]]);
		const content = withError(kv ? h("div", { class: "tool-view" }, kv) : undefined, result);
		return content ? { label: hostPathOf(url) || undefined, content, copyText: result.text } : undefined;
	}
	const [line = ""] = result.text.split("\n");
	if (!/^HTTP \d{3}\b/.test(line)) return undefined;
	const rest = result.text.slice(line.length).trim();
	const pretty = rest ? prettyJson(rest) : undefined;
	const content = h("div", { class: "tool-view" },
		url ? h("div", { class: "tv-url" }, `${method !== "GET" ? `${method} ` : ""}${url}`) : null,
		h("div", { class: "tv-status" }, line),
		rest ? (pretty !== undefined ? codeBlock(clampedText(pretty), "json", "tool-code") : h("pre", { class: "tv-preview" }, clampedText(rest))) : null,
	);
	return { label: fetchStatusMeta(result.details) ?? (hostPathOf(url) || undefined), content, copyText: result.text };
};

const codemodeBody = (args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	const code = typeof args.code === "string" ? args.code : undefined;
	const parsed = result ? parseCodemodeResult(result.text) : undefined;
	if (!code && !result) return undefined;
	const blocks: Node[] = [];
	if (code) blocks.push(codeBlock(clampedText(code), "javascript", "tool-code"));
	if (parsed) {
		const output = parsed.output.trim();
		const json = output ? prettyJson(output) : undefined;
		if (blocks.length) blocks.push(h("div", { class: "tool-divider" }));
		blocks.push(h("div", { class: "tool-view" },
			h("div", { class: "tv-head" },
				h("span", { class: "tv-chip", "data-tone": parsed.ok ? "success" : "danger" }, t(parsed.ok ? "tool.done" : "tool.error")),
				!code ? h("span", { class: "tv-meta" }, t("tool.wallTime", parsed.seconds)) : null,
			),
			output ? (json !== undefined
				? codeBlock(clampedText(json), "json", "tool-code")
				: h("pre", { class: parsed.ok ? "tv-preview" : "tv-preview error" }, clampedText(output))) : null,
		));
	} else if (result) {
		if (blocks.length) blocks.push(h("div", { class: "tool-divider" }));
		blocks.push(h("pre", { class: result.isError ? "tool-raw-pre error" : "tool-raw-pre" }, clampedText(result.text)));
	}
	return {
		label: code ? "JavaScript" : (parsed ? t("tool.wallTime", parsed.seconds) : undefined),
		content: h("div", { class: "tv-stack" }, ...blocks),
		copyText: parsed?.output.trim() || result?.text || code || "",
	};
};

const lsBody = (args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	if (!result || result.isError) return undefined;
	const listing = parseListing(result.text);
	if (!listing || (!listing.entries.length && !listing.note && !listing.empty)) return undefined;
	const content = h("div", { class: "tool-view" },
		listing.empty ? h("div", { class: "tv-meta" }, listing.empty)
			: h("div", { class: "tv-rows" },
				...listing.entries.map((entry) => h("div", { class: "tv-row" },
					h("span", { class: entry.directory ? "tv-name mono dir" : "tv-name mono" }, entry.name),
					entry.size !== undefined ? h("span", { class: "tv-size" }, formatBytes(entry.size)) : null,
				)),
				listing.note ? h("div", { class: "tv-note" }, listing.note) : null,
			),
	);
	return { label: String(args.path ?? "/workspace"), content, copyText: result.text };
};

const readBody = (args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	if (!result || result.isError) return undefined;
	const path = String(args.path ?? "");
	const language = path ? languageForPath(path) : undefined;
	const notes = (result.diagnostics ?? []).map((diagnostic) => diagnostic.message).filter(Boolean);
	const body = result.text
		? codeBlock(clampedText(result.text), language, "tool-code")
		: h("div", { class: "tool-view" }, h("div", { class: "tv-note" }, notes[0] ?? t("tool.emptyFile")));
	const extraNotes = result.text && notes.length ? h("div", { class: "tv-footer-note" }, notes.join(" · ")) : null;
	return {
		label: path || undefined,
		content: extraNotes ? h("div", { class: "tv-stack" }, body, extraNotes) : body,
		copyText: result.text,
	};
};

const writeBody = (args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	if (typeof args.content !== "string") return undefined;
	const path = String(args.path ?? "");
	const language = path ? languageForPath(path) : undefined;
	const bytes = new TextEncoder().encode(args.content).length;
	const body = args.content
		? codeBlock(clampedText(args.content), language, "tool-code")
		: h("div", { class: "tool-view" }, h("div", { class: "tv-note" }, t("tool.emptyFile")));
	const content = withError(body, result);
	if (!content) return undefined;
	return {
		label: [path, formatBytes(bytes)].filter(Boolean).join(" · ") || undefined,
		content,
		copyText: args.content,
	};
};

function renderDiffLines(diff: string): HTMLElement {
	const lines = diff.split("\n");
	return h("div", { class: "tv-diff" }, ...lines.map((line) => {
		const prefix = line[0];
		const trimmed = line.trim();
		if (trimmed === "..." || trimmed === "---") {
			return h("div", { class: "tv-diff-line", "data-kind": "gap" }, h("span", { class: "tv-diff-code" }, "…"));
		}
		const kind = prefix === "+" ? "add" : prefix === "-" ? "del" : "ctx";
		const match = /^[ +\-](\s*\d+|\s+)\s(.*)$/.exec(line);
		const num = match?.[1]?.trim() ?? "";
		const code = match ? match[2]! : (prefix === "+" || prefix === "-" || prefix === " " ? line.slice(1) : line);
		return h("div", { class: "tv-diff-line", "data-kind": kind },
			h("span", { class: "tv-diff-sign" }, prefix === "+" || prefix === "-" ? prefix : " "),
			num ? h("span", { class: "tv-diff-num" }, num) : null,
			h("span", { class: "tv-diff-code" }, code || " "),
		);
	}));
}

function editsToDiff(edits: unknown): string | undefined {
	if (!Array.isArray(edits) || !edits.length) return undefined;
	const chunks: string[] = [];
	for (const entry of edits) {
		const item = record(entry);
		if (!item || typeof item.oldText !== "string" || typeof item.newText !== "string") continue;
		for (const line of item.oldText.split("\n")) chunks.push(`- ${line}`);
		for (const line of item.newText.split("\n")) chunks.push(`+ ${line}`);
		chunks.push("...");
	}
	if (chunks.at(-1) === "...") chunks.pop();
	return chunks.length ? chunks.join("\n") : undefined;
}

const editBody = (args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	const path = String(args.path ?? "");
	const details = record(result?.details);
	const diff = typeof details?.diff === "string" ? details.diff : editsToDiff(args.edits);
	const diffNode = diff ? renderDiffLines(clampedText(diff)) : undefined;
	const content = withError(diffNode, result);
	if (!content) return undefined;
	return {
		label: path || undefined,
		content,
		copyText: typeof details?.patch === "string" ? details.patch : (diff ?? result?.text ?? ""),
	};
};

const tabsListBody = (_args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	if (!result || result.isError) return undefined;
	const list = parseJsonArray(result.text);
	if (!list) return undefined;
	const rows = list.flatMap((entry) => {
		const tab = record(entry);
		if (!tab || typeof tab.tabId !== "number" || typeof tab.url !== "string") return [];
		return [h("div", { class: "tv-row" },
			h("span", { class: "tv-dot", "data-active": tab.active === true ? "true" : undefined }),
			h("span", { class: "tv-ref" }, `#${tab.tabId}`),
			h("span", { class: "tv-name" }, String(tab.title || hostOf(tab.url))),
			h("span", { class: "tv-meta mono" }, hostPathOf(tab.url)),
		)];
	});
	return {
		label: t("tool.tabCount", list.length),
		content: h("div", { class: "tool-view" }, h("div", { class: "tv-rows" }, ...rows)),
		copyText: result.text,
	};
};

const kvBody = (
	buildRows: (args: Record<string, unknown>, result?: ToolResult) => readonly (readonly [string, Node | string | undefined, boolean?])[],
	labelOf?: (args: Record<string, unknown>, result?: ToolResult) => string | undefined,
) => (args: Record<string, unknown>, result?: ToolResult): ToolBodyView | undefined => {
	const kv = kvRows(buildRows(args, result));
	const view = kv ? h("div", { class: "tool-view" }, kv) : undefined;
	const content = withError(view, result);
	if (!content) return undefined;
	return {
		label: labelOf?.(args, result),
		content,
		copyText: result?.text || JSON.stringify(args, null, 2),
	};
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
	defineToolView({
		name: "page_snapshot", icon: "eye", label: t("tool.snapshot"),
		argsMeta: refOrSelectorMeta, resultMeta: snapshotResultMeta, body: snapshotBody,
	}),
	defineToolView({
		name: "page_inspect", icon: "code", label: t("tool.inspect"),
		argsMeta: refOrSelectorMeta, resultMeta: inspectResultMeta, body: inspectBody,
	}),
	defineToolView({
		name: "page_screenshot", icon: "camera", label: t("tool.screenshot"),
		argsMeta: (args) => Array.isArray(args.region) ? `[${args.region.join(", ")}]` : "",
		resultMeta: (details) => {
			const shot = record(record(details)?.screenshot);
			return shot && count(shot.width) && count(shot.height) ? `${shot.width}×${shot.height}` : undefined;
		},
	}),
	defineToolView({
		name: "page_click", icon: "pointer", label: t("tool.click"),
		argsMeta: (args) => args.ref !== undefined ? String(args.ref)
			: args.x !== undefined && args.y !== undefined ? `${args.x}, ${args.y}` : "",
		resultMeta: elementLabel,
		body: kvBody((args, result) => [
			[t("tool.kv.element"), elementLabel(result?.details)],
			[t("tool.kv.point"), args.x !== undefined && args.y !== undefined ? `${args.x}, ${args.y}` : undefined, true],
			[t("tool.kv.ref"), typeof args.ref === "string" ? args.ref : undefined, true],
			[t("tool.kv.tab"), typeof args.tabId === "number" ? `#${args.tabId}` : undefined, true],
		]),
	}),
	defineToolView({
		name: "page_type", icon: "keyboard", label: t("tool.type"),
		argsMeta: quotedTextMeta, resultMeta: elementAndInputMeta,
		body: kvBody((args, result) => [
			[t("tool.kv.element"), elementLabel(result?.details)],
			[t("tool.kv.text"), typeof args.text === "string" ? args.text : undefined],
			[t("tool.kv.submit"), args.submit === true ? t("tool.yes") : undefined],
			[t("tool.kv.ref"), typeof args.ref === "string" ? args.ref : undefined, true],
			[t("tool.kv.tab"), typeof args.tabId === "number" ? `#${args.tabId}` : undefined, true],
		]),
	}),
	defineToolView({
		name: "page_select", icon: "list", label: t("tool.select"),
		argsMeta: (args) => String(args.option ?? ""), resultMeta: elementAndInputMeta,
		body: kvBody((args, result) => [
			[t("tool.kv.element"), elementLabel(result?.details)],
			[t("tool.kv.option"), typeof args.option === "string" ? args.option : undefined],
			[t("tool.kv.ref"), typeof args.ref === "string" ? args.ref : undefined, true],
			[t("tool.kv.tab"), typeof args.tabId === "number" ? `#${args.tabId}` : undefined, true],
		]),
	}),
	defineToolView({
		name: "page_press", icon: "keyboard", label: t("tool.press"),
		argsMeta: (args) => [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key ?? ""].join("+"),
		resultMeta: elementAndInputMeta,
		body: kvBody((args, result) => [
			[t("tool.kv.key"), keycaps(args)],
			[t("tool.kv.element"), elementLabel(result?.details)],
			[t("tool.kv.ref"), typeof args.ref === "string" ? args.ref : undefined, true],
			[t("tool.kv.tab"), typeof args.tabId === "number" ? `#${args.tabId}` : undefined, true],
		]),
	}),
	defineToolView({
		name: "page_hover", icon: "pointer", label: t("tool.hover"),
		argsMeta: refMeta, resultMeta: elementLabel,
		body: kvBody((args, result) => [
			[t("tool.kv.element"), elementLabel(result?.details)],
			[t("tool.kv.ref"), typeof args.ref === "string" ? args.ref : undefined, true],
			[t("tool.kv.tab"), typeof args.tabId === "number" ? `#${args.tabId}` : undefined, true],
		]),
	}),
	defineToolView({
		name: "page_upload", icon: "paperclip", label: t("tool.upload"),
		argsMeta: (args) => Array.isArray(args.paths) ? args.paths.join(", ") : "",
		resultMeta: elementLabel,
		body: kvBody((args, result) => [
			[t("tool.kv.element"), elementLabel(result?.details)],
			[t("tool.kv.files"), Array.isArray(args.paths) ? args.paths.join(", ") : undefined],
			[t("tool.kv.ref"), typeof args.ref === "string" ? args.ref : undefined, true],
			[t("tool.kv.tab"), typeof args.tabId === "number" ? `#${args.tabId}` : undefined, true],
		]),
	}),
	defineToolView({
		name: "page_wait", icon: "refresh", label: t("tool.wait"),
		argsMeta: (args) => String(args.selector ?? args.text ?? (args.timeoutMs ? `${args.timeoutMs} ms` : "")),
		resultMeta: (_details, argsMeta, result) => {
			if (!result || result.isError) return undefined;
			const data = parseJsonRecord(result.text);
			if (!data || typeof data.ok !== "boolean") return undefined;
			const status = t(data.ok ? "tool.ready" : "tool.timedOut");
			return argsMeta ? `${argsMeta} · ${status}` : status;
		},
		body: kvBody((args, result) => {
			const data = result && !result.isError ? parseJsonRecord(result.text) : undefined;
			const status = data && typeof data.ok === "boolean" ? t(data.ok ? "tool.ready" : "tool.timedOut") : undefined;
			return [
				[t("tool.kv.target"), String(args.selector ?? args.text ?? "") || undefined, Boolean(args.selector)],
				[t("tool.kv.status"), status],
				[t("tool.kv.detail"), typeof data?.detail === "string" ? data.detail : undefined],
			];
		}),
	}),
	defineToolView({
		name: "page_scroll", icon: "scroll", label: t("tool.scroll"),
		argsMeta: (args) => (args.ref ? String(args.ref) : args.pixels ? `${args.pixels}px` : ""),
		resultMeta: elementLabel,
		body: kvBody((args, result) => [
			[t("tool.kv.element"), elementLabel(result?.details)],
			[t("tool.kv.scroll"), typeof args.pixels === "number" ? `${args.pixels}px` : undefined, true],
			[t("tool.kv.ref"), typeof args.ref === "string" ? args.ref : undefined, true],
		]),
	}),
	defineToolView({
		name: "tabs_list", icon: "tabs", label: t("tool.tabs"),
		resultMeta: (_details, _argsMeta, result) => {
			if (!result || result.isError) return undefined;
			const list = parseJsonArray(result.text);
			return list ? t("tool.tabCount", list.length) : undefined;
		},
		body: tabsListBody,
	}),
	defineToolView({
		name: "tab_open", icon: "external", label: t("tool.open"),
		argsMeta: (args) => hostPathOf(args.url),
		resultMeta: (_details, _argsMeta, result) => {
			if (!result || result.isError) return undefined;
			const tab = parseJsonRecord(result.text);
			if (!tab) return undefined;
			return [typeof tab.title === "string" ? clip(tab.title, 36) : "", hostOf(tab.url)].filter(Boolean).join(" · ") || undefined;
		},
		body: kvBody((args, result) => {
			const tab = result && !result.isError ? parseJsonRecord(result.text) : undefined;
			return [
				[t("tool.kv.title"), typeof tab?.title === "string" ? tab.title : undefined],
				[t("tool.kv.url"), typeof tab?.url === "string" ? tab.url : (typeof args.url === "string" ? args.url : undefined), true],
				[t("tool.kv.tab"), typeof tab?.tabId === "number" ? `#${tab.tabId}` : undefined, true],
			];
		}),
	}),
	defineToolView({
		name: "tab_navigate",
		icon: (args) => (args.back === true || args.history === "back" ? "back"
			: args.history === "forward" ? "forward" : args.history === "reload" ? "refresh" : "globe"),
		label: (args) => t(args.back === true || args.history === "back" ? "tool.back"
			: args.history === "forward" ? "tool.forward" : args.history === "reload" ? "tool.reload" : "tool.navigate"),
		argsMeta: (args) => (args.back === true || args.history !== undefined ? "" : hostPathOf(args.url)),
		resultMeta: (_details, _argsMeta, result) => {
			if (!result || result.isError) return undefined;
			const tab = parseJsonRecord(result.text);
			if (!tab) return undefined;
			return [typeof tab.title === "string" ? clip(tab.title, 36) : "", hostOf(tab.url)].filter(Boolean).join(" · ") || undefined;
		},
		body: kvBody((args, result) => {
			const tab = result && !result.isError ? parseJsonRecord(result.text) : undefined;
			return [
				[t("tool.kv.title"), typeof tab?.title === "string" ? tab.title : undefined],
				[t("tool.kv.url"), typeof tab?.url === "string" ? tab.url : (typeof args.url === "string" ? args.url : undefined), true],
				[t("tool.kv.tab"), typeof tab?.tabId === "number" ? `#${tab.tabId}` : undefined, true],
			];
		}),
	}),
	defineToolView({
		name: "tab_activate", icon: "tabs", label: t("tool.activate"), argsMeta: tabIdMeta,
		resultMeta: (_details, _argsMeta, result) => {
			if (!result || result.isError) return undefined;
			const tab = parseJsonRecord(result.text);
			return tab ? clip(String(tab.title || hostOf(tab.url)), 48) || undefined : undefined;
		},
		body: kvBody((args, result) => {
			const tab = result && !result.isError ? parseJsonRecord(result.text) : undefined;
			return [
				[t("tool.kv.tab"), args.tabId !== undefined ? `#${args.tabId}` : undefined, true],
				[t("tool.kv.title"), typeof tab?.title === "string" ? tab.title : undefined],
				[t("tool.kv.url"), typeof tab?.url === "string" ? tab.url : undefined, true],
			];
		}),
	}),
	defineToolView({
		name: "tab_close", icon: "x", label: t("tool.close"), argsMeta: tabIdMeta,
		body: kvBody((args, result) => [
			[t("tool.kv.tab"), args.tabId !== undefined ? `#${args.tabId}` : undefined, true],
			[t("tool.kv.status"), result && !result.isError ? result.text : undefined],
		]),
	}),
	defineToolView({
		name: "codemode", icon: "code", label: t("tool.code"),
		resultMeta: (_details, _argsMeta, result) => {
			if (!result) return undefined;
			const parsed = parseCodemodeResult(result.text);
			return parsed ? t("tool.wallTime", parsed.seconds) : undefined;
		},
		body: codemodeBody,
	}),
	defineToolView({
		names: ["read", "read_text"], icon: "file", label: t("tool.read"), argsMeta: pathMeta,
		resultMeta: (details, argsMeta, result) => {
			if (!result || result.isError || !result.text) return undefined;
			const truncation = record(record(details)?.truncation);
			const lines = count(truncation?.totalLines) && count(truncation?.outputLines)
				? `${truncation.outputLines} / ${truncation.totalLines}`
				: result.text.split("\n").length;
			return [argsMeta, t("tool.lines", lines)].filter(Boolean).join(" · ");
		},
		body: readBody,
	}),
	defineToolView({
		name: "write", icon: "file", label: t("tool.write"), argsMeta: pathMeta,
		resultMeta: (_details, argsMeta, result) => {
			if (!result || result.isError) return undefined;
			const match = /\b(\d+) bytes\b/.exec(result.text);
			return match ? [argsMeta, formatBytes(Number(match[1]))].filter(Boolean).join(" · ") : undefined;
		},
		body: writeBody,
	}),
	defineToolView({
		name: "edit", icon: "compose", label: t("tool.edit"), argsMeta: pathMeta,
		body: editBody,
	}),
	defineToolView({
		name: "ls", icon: "folder", label: t("tool.ls"), argsMeta: (args) => String(args.path ?? "/workspace"),
		resultMeta: (_details, argsMeta, result) => {
			if (!result || result.isError) return undefined;
			const listing = parseListing(result.text);
			return listing && (listing.entries.length || listing.empty) ? [argsMeta, t("tool.items", listing.entries.length)].filter(Boolean).join(" · ") : undefined;
		},
		body: lsBody,
	}),
	defineToolView({
		name: "fetch", icon: "download", label: t("tool.fetch"),
		argsMeta: (args) => {
			const target = hostPathOf(args.url);
			const method = typeof args.method === "string" && args.method !== "GET" ? args.method : "";
			return [method, target].filter(Boolean).join(" ");
		},
		resultMeta: fetchResultMeta,
		body: fetchBody,
	}),
];

for (const view of BUILTIN_VIEWS) registerToolView(view);
