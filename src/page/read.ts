import type { Static } from "../lib/chord.ts";
import { LIMITS } from "../tools/page-limits.ts";
import type { InspectResult, PageToolArgs as Args, SnapshotResult, Structure } from "../tools/page-tools.ts";
import { clip, cut, RAW_CELLS, RAW_ROWS, type RawRow, shapeGrid, squash, take, takeWhere } from "./limits.ts";
import { atPoint, deep, deepMatching, element, frameDoc, INTERACTIVE, isTable, lineOf, matching, nameOf, observe, onscreen, own, parentOf, ref, roleOf, shadowOf, tagOf, textOf, topRect, visible } from "./tree.ts";

const TABLES = "table, [role=table], [role=grid], [role=treegrid]";
const LISTS = "ul, ol, dl";
const DEFAULT_STYLES = [
	"display", "visibility", "opacity", "position", "z-index", "width", "height", "margin", "padding", "overflow",
	"color", "background-color", "font-size", "font-weight", "pointer-events", "cursor",
];
const REDACTED = "[redacted]";

const clean = (text: string) => text.replace(/\n{3,}/g, "\n\n");

function componentText(root: ShadowRoot): string {
	const range = root.ownerDocument.createRange();
	const read = (node: Node): string => {
		if (node.nodeType === Node.TEXT_NODE) {
			const parent = node.parentElement ?? root.host;
			if (own(parent).getComputedStyle(parent).visibility !== "visible") return "";
			range.selectNodeContents(node);
			return range.getClientRects().length ? node.textContent ?? "" : "";
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return "";
		const element = node as Element;
		if (element.matches("script, style, template, noscript")) return "";
		if (own(element).getComputedStyle(element).display === "contents") return [...element.childNodes].map(read).join(" ");
		return visible(element) ? textOf(element) : "";
	};
	return [...root.childNodes].map(read).join(" ");
}

/** The root's text plus what flat `innerText` misses: the text of same-origin frames and of page components. */
function pageText(root: Element): string {
	const main = clean(textOf(root));
	const flat = squash(main);
	const blocks: string[] = [];
	const components: string[] = [];
	for (const each of deep(root)) {
		const frame = frameDoc(each);
		if (frame && visible(each)) {
			const text = clean(frame.body ? textOf(frame.body) : "");
			if (squash(text)) {
				const title = clip(squash(frame.title || each.getAttribute("src") || "frame"), LIMITS.name)[0];
				blocks.push(`[Frame "${title}"]\n${text}`);
			}
		}
		const shadow = shadowOf(each);
		if (shadow && (visible(each) || own(each).getComputedStyle(each).display === "contents")) {
			const text = squash(componentText(shadow));
			if (text && !flat.includes(text) && !components.includes(text)) components.push(text);
		}
	}
	if (components.length) blocks.push(`[Inside page components]\n${components.join("\n")}`);
	return [main, ...blocks].filter(Boolean).join("\n\n");
}

function target({ ref: name, selector }: { ref?: string; selector?: string }, fallback?: Element): Element[] {
	if (name !== undefined && selector !== undefined) throw new Error("Pass either ref or selector, not both.");
	if (name !== undefined) return [element(name)];
	if (selector !== undefined) {
		const found = matching(selector);
		if (!found.length) throw new Error(`No element matches ${selector}.`);
		return found;
	}
	if (!fallback) throw new Error("Pass a ref or a selector.");
	return [fallback];
}

const CELLS = "[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]";

/** Visible rows, read only as far as `shapeGrid` can return them. */
function gridRows(table: Element): RawRow[] {
	if (isTable(table)) {
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

/** A list nested in another list inside `root` is already part of that list's item text. */
function outermost(list: Element, root: Element) {
	if (list === root) return true;
	for (let outer = parentOf(list); outer; outer = parentOf(outer)) {
		if (outer === root) return true;
		if (outer.matches(LISTS)) return false;
	}
	return true;
}

function structureOf(root: Element): Static<typeof Structure> {
	const [tables, moreTables] = takeWhere(deepMatching(root, TABLES), visible, LIMITS.tables);
	const candidates = (function* () {
		for (const list of deepMatching(root, LISTS)) {
			if (outermost(list, root) && visible(list)) yield { list, items: listItems(list) };
		}
	})();
	const [keptLists, moreLists] = takeWhere(candidates, ({ items }) => items.length > 0, LIMITS.lists);
	return {
		tables: tables.map((table) => {
			const caption = isTable(table) ? squash(table.caption?.textContent ?? "") : squash(table.getAttribute("aria-label") ?? "");
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

export function snapshot({ maxChars = 20_000, structure, textOffset = 0, ...scope }: Args<"page_snapshot">): Static<typeof SnapshotResult> {
	const body = document.body ?? document.documentElement;
	const [root = body] = target(scope, body);
	observe();
	const elements = [];
	let elementsTruncated = false;
	for (const candidate of deepMatching(root, INTERACTIVE)) {
		if (!visible(candidate)) continue;
		if (elements.length >= LIMITS.snapshotElements) {
			elementsTruncated = true;
			break;
		}
		elements.push(lineOf(candidate));
	}
	const text = pageText(root);
	const [shown, truncated] = cut(text.slice(textOffset), maxChars);
	return {
		url: clip(location.href, LIMITS.url)[0],
		title: clip(document.title, LIMITS.title)[0],
		text: shown,
		truncated,
		textOffset,
		totalChars: text.length,
		elements,
		elementsTruncated,
		viewport: { height: innerHeight, scrollY: Math.round(window.scrollY), scrollHeight: document.documentElement.scrollHeight },
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
		const box = topRect(target);
		const round = (n: number) => Math.round(n * 10) / 10;
		result.box = {
			x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height),
			inViewport: onscreen(box) && (box.width > 0 || box.height > 0),
		};
	}
	if (include.has("styles")) {
		const computed = own(target).getComputedStyle(target);
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

export function describe({ ref: name, x, y }: { ref?: string; x?: number; y?: number }) {
	if (name !== undefined) {
		const target = element(name);
		return { role: roleOf(target), name: nameOf(target) };
	}
	const found = x !== undefined && y !== undefined ? atPoint(x, y) : null;
	if (!found) throw new Error(`Nothing is at (${x}, ${y}).`);
	return { role: roleOf(found.element), name: nameOf(found.element) };
}

export function viewport() {
	return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
}
