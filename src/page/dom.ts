import type { Static } from "../lib/chord.ts";
import type { InspectResult, PageToolArgs as Args, SnapshotResult, Structure } from "../tools/page-tools.ts";
import { clip, cut, LIMITS, RAW_CELLS, RAW_ROWS, type RawRow, shapeGrid, squash, take, takeWhere } from "./limits.ts";
import { RefTable } from "./refs.ts";

const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [contenteditable=true], [tabindex]";
const TABLES = "table, [role=table], [role=grid], [role=treegrid]";
const LISTS = "ul, ol, dl";
const DEFAULT_STYLES = [
	"display", "visibility", "opacity", "position", "z-index", "width", "height", "margin", "padding", "overflow",
	"color", "background-color", "font-size", "font-weight", "pointer-events", "cursor",
];
const REDACTED = "[redacted]";

const refs = new RefTable<Element>();
// Same-document navigations between tool calls (Navigation API where the browser has it, and history traversal).
const observe = () => refs.observe(location.href);
(globalThis as { navigation?: EventTarget }).navigation?.addEventListener("currententrychange", observe);
addEventListener("popstate", observe);
const ref = (target: Element) => refs.add(target, location.href);
const element = (name: string) => refs.resolve(name, location.href);

function visible(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return false;
	const style = getComputedStyle(element);
	return style.visibility !== "hidden" && style.display !== "none";
}

function nameOf(element: Element): string {
	const label =
		element.getAttribute("aria-label") ??
		(element as HTMLInputElement).labels?.[0]?.textContent ??
		element.getAttribute("placeholder") ??
		element.getAttribute("title") ??
		element.textContent ??
		(element as HTMLInputElement).value ??
		"";
	return clip(squash(label), LIMITS.name)[0];
}

function roleOf(element: Element): string {
	const explicit = element.getAttribute("role");
	if (explicit) return clip(explicit, LIMITS.name)[0];
	const tag = element.tagName.toLowerCase();
	if (tag === "a") return "link";
	if (tag === "input") return `input:${(element as HTMLInputElement).type || "text"}`;
	return clip(tag, LIMITS.name)[0];
}

const tagOf = (element: Element) => clip(element.tagName.toLowerCase(), LIMITS.name)[0];

const textOf = (element: Element) => (element instanceof HTMLElement ? element.innerText : element.textContent) ?? "";

/** `root` and the elements under it matching `selector`, in document order. */
function within(root: Element, selector: string): Element[] {
	return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
}

function select(selector: string): Element[] {
	try {
		return [...document.querySelectorAll(selector)];
	} catch {
		throw new Error(`Invalid CSS selector: ${selector}`);
	}
}

/** The element named by exactly one of `ref` and `selector`, or `fallback` when neither is given. */
function target({ ref: name, selector }: { ref?: string; selector?: string }, fallback?: Element): Element[] {
	if (name !== undefined && selector !== undefined) throw new Error("Pass either ref or selector, not both.");
	if (name !== undefined) return [element(name)];
	if (selector !== undefined) {
		const found = select(selector);
		if (!found.length) throw new Error(`No element matches ${selector}.`);
		return found;
	}
	if (!fallback) throw new Error("Pass a ref or a selector.");
	return [fallback];
}

const CELLS = "[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]";

/** Visible rows, read only as far as `shapeGrid` can return them. */
function gridRows(table: Element): RawRow[] {
	if (table instanceof HTMLTableElement) {
		const [rows] = takeWhere(table.rows, visible, RAW_ROWS);
		return rows.map((row) => {
			const cells = [...row.cells].slice(0, RAW_CELLS);
			return { header: cells.length > 0 && cells.every((cell) => cell.tagName === "TH"), cells: cells.map(textOf) };
		});
	}
	const [rows] = takeWhere(table.querySelectorAll("[role=row]"), (row) => row.parentElement?.closest(TABLES) === table && visible(row), RAW_ROWS);
	return rows.map((row) => {
		const [cells] = takeWhere(row.querySelectorAll(CELLS), (cell) => cell.closest("[role=row]") === row, RAW_CELLS);
		return { header: cells.length > 0 && cells.every((cell) => cell.getAttribute("role") === "columnheader"), cells: cells.map(textOf) };
	});
}

/** Visible items, up to one past the limit. */
function listItems(list: Element): string[] {
	if (list.tagName !== "DL") return takeWhere(list.children, (child) => child.tagName === "LI" && visible(child), LIMITS.items + 1)[0].map(textOf);
	const entries: { term: string; details: string[] }[] = [];
	for (const child of list.querySelectorAll(":scope > dt, :scope > dd, :scope > div > dt, :scope > div > dd")) {
		if (!visible(child)) continue;
		const text = squash(textOf(child));
		const last = entries.at(-1);
		if (child.tagName === "DT" || !last) {
			if (entries.length > LIMITS.items) break;
			entries.push(child.tagName === "DT" ? { term: text, details: [] } : { term: "", details: [text] });
		} else last.details.push(text);
	}
	return entries.map(({ term, details }) => [term, details.join("; ")].filter(Boolean).join(": "));
}

/** A list nested in another list of the same subtree is already part of that list's item text. */
function outermost(list: Element, root: Element) {
	const outer = list === root ? null : list.parentElement?.closest(LISTS);
	return !outer || !root.contains(outer);
}

function structureOf(root: Element): Static<typeof Structure> {
	const [tables, moreTables] = takeWhere(within(root, TABLES), visible, LIMITS.tables);
	const candidates = (function* () {
		for (const list of within(root, LISTS)) {
			if (outermost(list, root) && visible(list)) yield { list, items: listItems(list) };
		}
	})();
	const [keptLists, moreLists] = takeWhere(candidates, ({ items }) => items.length > 0, LIMITS.lists);
	return {
		tables: tables.map((table) => {
			const caption = table instanceof HTMLTableElement ? squash(table.caption?.textContent ?? "") : squash(table.getAttribute("aria-label") ?? "");
			return { ref: ref(table), ...(caption ? { caption: clip(caption, LIMITS.cell)[0] } : {}), ...shapeGrid(gridRows(table)) };
		}),
		lists: keptLists.map(({ list, items }) => {
			const [kept, more] = take(items, LIMITS.items);
			let clipped = false;
			const shaped = kept.map((item) => {
				const [text, cutItem] = clip(squash(item), LIMITS.item);
				clipped ||= cutItem;
				return text;
			});
			return { ref: ref(list), kind: list.tagName.toLowerCase() as "ul" | "ol" | "dl", items: shaped, truncated: more || clipped };
		}),
		truncated: moreTables || moreLists,
	};
}

export function snapshot({ maxChars = 20_000, structure, ...scope }: Args<"page_snapshot">): Static<typeof SnapshotResult> {
	const body = document.body ?? document.documentElement;
	const [root = body] = target(scope, body);
	refs.begin(location.href);
	const elements = [];
	for (const candidate of within(root, INTERACTIVE)) {
		if (!visible(candidate)) continue;
		elements.push({ ref: ref(candidate), role: roleOf(candidate), name: nameOf(candidate) });
		if (elements.length >= LIMITS.snapshotElements) break;
	}
	const text = textOf(root).replace(/\n{3,}/g, "\n\n");
	const [shown, truncated] = cut(text, maxChars);
	return {
		url: clip(location.href, LIMITS.url)[0],
		title: clip(document.title, LIMITS.title)[0],
		text: shown,
		truncated,
		elements,
		...(structure ? { structure: structureOf(root) } : {}),
	};
}

const isPassword = (element: Element) => element.tagName === "INPUT" && element.getAttribute("type")?.trim().toLowerCase() === "password";

const templateContent = (element: Element) => element.tagName === "TEMPLATE" ? (element as HTMLTemplateElement).content.children : [];

/** `root` and every element under it, including inside `<template>` contents, which selectors do not reach. */
function* everyElement(root: Element): Generator<Element> {
	for (const each of [root, ...root.querySelectorAll("*")]) {
		yield each;
		for (const nested of templateContent(each)) yield* everyElement(nested);
	}
}

function htmlOf(element: Element): string {
	const hasPassword = (root: Element) => {
		for (const each of everyElement(root)) if (isPassword(each) && each.hasAttribute("value")) return true;
		return false;
	};
	if (!hasPassword(element)) return element.outerHTML;
	const copy = element.cloneNode(true) as Element;
	for (const each of everyElement(copy)) if (isPassword(each) && each.hasAttribute("value")) each.setAttribute("value", REDACTED);
	return copy.outerHTML;
}

function inspectOne(target: Element, include: ReadonlySet<string>, styles: readonly string[], maxHtml: number) {
	let truncated = false;
	const result: Static<typeof InspectResult>["elements"][number] = {
		ref: ref(target),
		tag: tagOf(target),
		visible: visible(target),
		truncated: false,
	};
	if (include.has("attributes")) {
		// An overlong name is left out rather than cut: a cut name would be a different attribute.
		const named = [...target.attributes].filter(({ name }) => name.length <= LIMITS.attributeName);
		const [attributes, more] = take(named, LIMITS.attributes);
		truncated ||= more || named.length < target.attributes.length;
		result.attributes = Object.fromEntries(attributes.map(({ name, value }) => {
			if (name === "value" && isPassword(target)) return [name, REDACTED];
			const [shown, clipped] = clip(value, LIMITS.attributeValue);
			truncated ||= clipped;
			return [name, shown];
		}));
	}
	if (include.has("box")) {
		const rect = target.getBoundingClientRect();
		const round = (n: number) => Math.round(n * 10) / 10;
		result.box = {
			x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
			inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth && (rect.width > 0 || rect.height > 0),
		};
	}
	if (include.has("styles")) {
		const computed = getComputedStyle(target);
		result.styles = Object.fromEntries(styles.map((name) => [name, clip(computed.getPropertyValue(name), LIMITS.attributeValue)[0]]));
	}
	if (include.has("html")) {
		const [html, clipped] = cut(htmlOf(target), maxHtml);
		truncated ||= clipped;
		result.html = html;
	}
	result.truncated = truncated;
	return result;
}

export function inspect(args: Args<"page_inspect">): Static<typeof InspectResult> {
	const found = target(args);
	const include = new Set<string>(args.include ?? ["html", "attributes", "styles", "box"]);
	const [shown, more] = take(found, args.maxElements ?? LIMITS.inspectElements);
	const elements = shown.map((each) => inspectOne(each, include, args.styles ?? DEFAULT_STYLES, args.maxHtml ?? LIMITS.html));
	return { url: clip(location.href, LIMITS.url)[0], matched: found.length, truncated: more || elements.some((each) => each.truncated), elements };
}

export function click({ ref }: Args<"page_click">) {
	const target = element(ref) as HTMLElement;
	target.scrollIntoView({ block: "center" });
	target.click();
	return { ok: true };
}

export function type({ ref, text, submit }: Args<"page_type">) {
	const target = element(ref) as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
	target.focus();
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		// The native setter, so frameworks that track the value see the change.
		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
		setter?.call(target, text);
		target.dispatchEvent(new Event("input", { bubbles: true }));
		target.dispatchEvent(new Event("change", { bubbles: true }));
	} else {
		target.textContent = text;
		target.dispatchEvent(new InputEvent("input", { bubbles: true }));
	}
	if (submit) {
		const form = (target as HTMLInputElement).form;
		if (form) form.requestSubmit();
		else target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	}
	return { ok: true };
}

export function scroll({ ref, pixels }: Args<"page_scroll">) {
	if (ref !== undefined) element(ref).scrollIntoView({ block: "center" });
	else window.scrollBy({ top: pixels ?? window.innerHeight * 0.8 });
	return { ok: true, detail: `scrollY=${Math.round(window.scrollY)}` };
}
