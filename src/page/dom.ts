import type { Static } from "../lib/chord.ts";
import { type InspectResult, type PageToolArgs as Args, type SnapshotResult, type Structure, WAIT } from "../tools/page-tools.ts";
import { LIMITS } from "../tools/page-limits.ts";
import type { UploadArgs } from "../contracts/page.ts";
import { clip, cut, RAW_CELLS, RAW_ROWS, type RawRow, shapeGrid, squash, take, takeWhere } from "./limits.ts";
import { RefTable } from "./refs.ts";

const INTERACTIVE = [
	"a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "[contenteditable=''], [contenteditable=true]", "[onclick]",
	...["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "combobox", "textbox"].map((role) => `[role=${role}]`),
	"[tabindex]:not([tabindex='-1'])",
].join(", ");
/** Inputs whose `value` is their caption, not something the user typed. */
const CAPTIONED = new Set(["submit", "button", "reset"]);
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
globalThis.addEventListener?.("popstate", observe);
const ref = (target: Element) => refs.add(target, location.href);
const element = (name: string) => refs.resolve(name, location.href);

/** The window an element lives in: frame contents come from another realm, so `instanceof` globals fail on them. */
const own = (element: Element): Window & typeof globalThis => (element.ownerDocument?.defaultView ?? window) as Window & typeof globalThis;
const isHtml = (element: Element): element is HTMLElement => element instanceof own(element).HTMLElement;
const isInput = (element: Element): element is HTMLInputElement => element.localName === "input" && isHtml(element);
const isSelect = (element: Element): element is HTMLSelectElement => element.localName === "select" && isHtml(element);
const isTextArea = (element: Element): element is HTMLTextAreaElement => element.localName === "textarea" && isHtml(element);
const isAnchor = (element: Element): element is HTMLAnchorElement => element.localName === "a" && isHtml(element);
const isButton = (element: Element): element is HTMLButtonElement => element.localName === "button" && isHtml(element);
const isTable = (element: Element): element is HTMLTableElement => element.localName === "table" && isHtml(element);

function visible(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return false;
	const style = own(element).getComputedStyle(element);
	return style.visibility !== "hidden" && style.display !== "none";
}

const inputType = (element: Element) => isInput(element) ? element.type : undefined;

function nameOf(element: Element): string {
	const type = inputType(element);
	// Label ids live in the element's own tree: its shadow root or document, not the top one.
	const root = element.getRootNode() as Document | ShadowRoot;
	const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => root.getElementById?.(id)?.textContent ?? "").join(" ");
	// A field's own text is its options or its content, never its name.
	const field = isSelect(element) || isTextArea(element) || type !== undefined;
	const sources = [
		element.getAttribute("aria-label"),
		labelled,
		(element as HTMLInputElement).labels?.[0]?.textContent,
		type !== undefined && CAPTIONED.has(type) ? (element as HTMLInputElement).value : undefined,
		element.getAttribute("placeholder"),
		element.getAttribute("alt"),
		field ? undefined : element.textContent,
		field ? undefined : element.querySelector("img[alt]")?.getAttribute("alt"),
		element.getAttribute("title"),
		element.getAttribute("name"),
	];
	for (const source of sources) {
		const text = squash(source ?? "");
		if (text) return clip(text, LIMITS.name)[0];
	}
	return "";
}

const isDisabled = (element: Element) => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";

const ariaFlag = (element: Element, name: string) => {
	const value = element.getAttribute(name);
	return value === "true" ? true : value === "false" ? false : undefined;
};

/** A password's text is never read. */
function stateOf(element: Element) {
	const type = inputType(element);
	const typed = isTextArea(element)
		|| (type !== undefined && type !== "password" && type !== "checkbox" && type !== "radio" && !CAPTIONED.has(type));
	const value = squash((isSelect(element) ? element.selectedOptions[0]?.text : typed ? (element as HTMLInputElement).value : "") ?? "");
	const checked = type === "checkbox" || type === "radio"
		? (element as HTMLInputElement).checked : ariaFlag(element, "aria-checked") ?? ariaFlag(element, "aria-selected");
	const expanded = ariaFlag(element, "aria-expanded");
	const href = isAnchor(element) ? element.href : "";
	return {
		...(value ? { value: clip(value, LIMITS.name)[0] } : {}),
		...(checked !== undefined ? { checked } : {}),
		...(isDisabled(element) ? { disabled: true } : {}),
		...(expanded !== undefined ? { expanded } : {}),
		...(href ? { href: clip(href, LIMITS.href)[0] } : {}),
	};
}

function roleOf(element: Element): string {
	const explicit = element.getAttribute("role");
	if (explicit) return clip(explicit, LIMITS.name)[0];
	const tag = element.tagName.toLowerCase();
	if (tag === "a") return "link";
	if (isInput(element)) return `input:${element.type || "text"}`;
	return clip(tag, LIMITS.name)[0];
}

const tagOf = (element: Element) => clip(element.tagName.toLowerCase(), LIMITS.name)[0];

const textOf = (element: Element) => (isHtml(element) ? element.innerText : element.textContent) ?? "";

const HIGHLIGHT_TAG = "oshawott-highlight";

// A content script reaches closed shadow roots only through these extension-only accessors.
function shadowOf(element: Element): ShadowRoot | null {
	if (element.shadowRoot) return element.shadowRoot;
	try {
		const root = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot } } })
			.chrome?.dom?.openOrClosedShadowRoot?.(element);
		if (root) return root;
	} catch { /* not a host, or no such accessor */ }
	// Firefox's accessor is a property (a method on some versions), exposed to content scripts only.
	try {
		const accessor = (element as { openOrClosedShadowRoot?: unknown }).openOrClosedShadowRoot;
		const root = typeof accessor === "function" ? accessor.call(element) : accessor;
		if (root) return root as ShadowRoot;
	} catch { /* not a host, or no such accessor */ }
	return null;
}

/** A frame's document when the page may read it: same-origin only. */
function frameDoc(element: Element): Document | null {
	if (element.localName !== "iframe" && element.localName !== "frame") return null;
	try {
		return (element as HTMLIFrameElement).contentDocument ?? null;
	} catch {
		return null;
	}
}

/** `root` and every element under it in document order, descending into shadow roots and same-origin frames. */
function* deep(root: Element): Generator<Element> {
	if (root.localName === HIGHLIGHT_TAG) return;
	yield root;
	const shadow = shadowOf(root);
	if (shadow) for (const child of shadow.children) yield* deep(child);
	for (const child of root.children) yield* deep(child);
	const frame = frameDoc(root);
	if (frame?.documentElement) yield* deep(frame.documentElement);
}

function* deepMatching(root: Element, selector: string): Generator<Element> {
	for (const candidate of deep(root)) if (candidate.matches(selector)) yield candidate;
}

/** The parent across shadow and frame boundaries, where `parentElement` stops. */
const parentOf = (element: Element): Element | null => {
	if (element.parentElement) return element.parentElement;
	const root = element.getRootNode();
	return (root as ShadowRoot).host ?? (root as Document).defaultView?.frameElement ?? null;
};

/** An element's rect in top-viewport CSS pixels: the space page_screenshot regions and coordinate clicks use. */
function topRect(element: Element) {
	let { left, right, top, bottom } = element.getBoundingClientRect();
	for (let win: Window | null = element.ownerDocument?.defaultView; win?.frameElement; win = win.parent) {
		const frame = win.frameElement;
		const box = frame.getBoundingClientRect();
		left += box.left + frame.clientLeft;
		right += box.left + frame.clientLeft;
		top += box.top + frame.clientTop;
		bottom += box.top + frame.clientTop;
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

const onscreen = (box: { x: number; y: number; width: number; height: number }) =>
	box.x + box.width > 0 && box.y + box.height > 0 && box.x < innerWidth && box.y < innerHeight;

/** The element line a snapshot element, an `appeared` entry and an action `target` share. */
function lineOf(element: Element) {
	return {
		ref: ref(element), role: roleOf(element), name: nameOf(element), ...stateOf(element),
		...(onscreen(topRect(element)) ? {} : { offscreen: true }),
	};
}

const clean = (text: string) => text.replace(/\n{3,}/g, "\n\n");

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
		if (shadow) {
			const text = squash([...shadow.children].map((child) => textOf(child)).join(" "));
			if (text && !flat.includes(text) && !components.includes(text)) components.push(text);
		}
	}
	if (components.length) blocks.push(`[Inside page components]\n${components.join("\n")}`);
	return [main, ...blocks].filter(Boolean).join("\n\n");
}

function matching(selector: string): Element[] {
	try {
		return [...document.querySelectorAll(selector)];
	} catch {
		throw new Error(`Invalid CSS selector: ${selector}`);
	}
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
	refs.observe(location.href);
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

const DIALOGS = "dialog[open], [role=dialog], [role=alertdialog]";
/** Dialogs and visible interactive elements when the last action began; `settled` reports what changed. */
let before = { dialogs: new Set<Element>() as ReadonlySet<Element>, interactive: new Set<Element>() as ReadonlySet<Element> };
const openDialogs = () => matching(DIALOGS).filter(visible);
/** How many interactive candidates the pre-action scan reads at most. */
const RECORD_SCAN = 5_000;
const recordBefore = () => {
	const interactive = new Set<Element>();
	let scanned = 0;
	for (const candidate of deepMatching(document.documentElement, INTERACTIVE)) {
		if (++scanned > RECORD_SCAN) break;
		if (visible(candidate)) interactive.add(candidate);
	}
	before = { dialogs: new Set(openDialogs()), interactive };
};

function dialogName(dialog: Element): string {
	const labelled = dialog.getAttribute("aria-label")
		?? dialog.querySelector("h1, h2, h3, h4, h5, h6, [role=heading]")?.textContent;
	return clip(squash(labelled ?? ""), LIMITS.name)[0] || nameOf(dialog);
}

/** The state after the last action: where the page is, what it opened, what appeared, what the target became. */
export function settled({ ref: name }: { ref?: string }) {
	const appeared = [];
	let appearedMore = false;
	for (const candidate of deepMatching(document.documentElement, INTERACTIVE)) {
		if (before.interactive.has(candidate) || !visible(candidate)) continue;
		if (appeared.length >= LIMITS.appeared) {
			appearedMore = true;
			break;
		}
		appeared.push(lineOf(candidate));
	}
	const target = name === undefined ? undefined : refs.peek(name, location.href);
	return {
		url: clip(location.href, LIMITS.url)[0],
		title: clip(document.title, LIMITS.title)[0],
		opened: [...new Set(openDialogs().filter((dialog) => !before.dialogs.has(dialog)).map(dialogName))],
		appeared,
		appearedMore,
		...(target?.isConnected ? { target: lineOf(target) } : {}),
		...(name !== undefined && !target?.isConnected ? { targetGone: true } : {}),
	};
}

export function viewport() {
	return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
}

const label = (target: Element) => `${roleOf(target)} "${nameOf(target)}"`;

function center(target: Element) {
	const rect = target.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** The deepest element at a top-viewport point — through shadow roots and same-origin frames — in its document's coordinates. */
function atPoint(x: number, y: number): { element: Element; x: number; y: number } | null {
	let scope: Document | ShadowRoot = document;
	let px = x;
	let py = y;
	for (let depth = 0; depth < 20; depth++) {
		let hit = scope.elementFromPoint(px, py);
		if (hit?.localName === "slot") hit = (hit as HTMLSlotElement).assignedElements({ flatten: true })[0] ?? hit;
		if (!hit || hit.localName === HIGHLIGHT_TAG) return null;
		const shadow = shadowOf(hit);
		if (shadow && typeof shadow.elementFromPoint === "function") {
			const inner = shadow.elementFromPoint(px, py);
			if (inner !== null && inner !== hit) {
				scope = shadow;
				continue;
			}
		}
		const frame = frameDoc(hit);
		if (frame) {
			const box = hit.getBoundingClientRect();
			px -= box.left + hit.clientLeft;
			py -= box.top + hit.clientTop;
			scope = frame;
			continue;
		}
		return { element: hit, x: px, y: py };
	}
	return null;
}

/** A transient marker where an action points: a box around the element, a ring at a coordinate click. */
let highlightHost: HTMLElement | undefined;
let highlightRoot: ShadowRoot | undefined;
function flash(box: { x: number; y: number; width: number; height: number }, ring = false) {
	try {
		if (!highlightHost?.isConnected || !highlightRoot) {
			highlightHost = document.createElement(HIGHLIGHT_TAG);
			highlightRoot = highlightHost.attachShadow({ mode: "closed" });
			document.documentElement.append(highlightHost);
		}
		const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
		const size = ring ? 28 : 0;
		const at = ring ? { x: box.x - size / 2, y: box.y - size / 2, width: size, height: size } : box;
		const mark = document.createElement("div");
		mark.style.cssText =
			`position:fixed;left:${at.x}px;top:${at.y}px;width:${at.width}px;height:${at.height}px;` +
			"pointer-events:none;z-index:2147483647;border:2px solid #3b82f6;" +
			`border-radius:${ring ? "50%" : "4px"};box-shadow:0 0 0 3px rgba(59,130,246,.35);` +
			`background:rgba(59,130,246,.08);${calm ? "" : "transition:opacity .3s ease .55s;"}`;
		highlightRoot.append(mark);
		setTimeout(() => { if (!calm) mark.style.opacity = "0"; }, 550);
		setTimeout(() => mark.remove(), 900);
	} catch { /* feedback only: it must never fail an action */ }
}

interface Press {
	button?: number;
	buttons?: number;
	detail?: number;
	at?: { x: number; y: number };
	modifiers?: readonly string[];
}

function point(target: Element, kinds: readonly string[], press: Press = {}) {
	const win = own(target);
	const at = press.at ?? center(target);
	const modifiers = press.modifiers ?? [];
	const init = {
		cancelable: true, composed: true, view: win,
		button: press.button ?? 0, buttons: press.buttons ?? 0, detail: press.detail ?? 1,
		clientX: at.x, clientY: at.y,
		altKey: modifiers.includes("Alt"), ctrlKey: modifiers.includes("Control"),
		metaKey: modifiers.includes("Meta"), shiftKey: modifiers.includes("Shift"),
	};
	let allowed = true;
	for (const kind of kinds) {
		const bubbles = !kind.endsWith("enter");
		const event = kind.startsWith("pointer") && win.PointerEvent
			? new win.PointerEvent(kind, { ...init, bubbles, pointerId: 1, pointerType: "mouse", isPrimary: true })
			: new win.MouseEvent(kind, { ...init, bubbles });
		allowed = target.dispatchEvent(event) && allowed;
	}
	return allowed;
}

const HOVER = ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"];

export function hover({ ref }: Args<"page_hover">) {
	recordBefore();
	const target = element(ref);
	target.scrollIntoView({ block: "center", inline: "nearest" });
	point(target, HOVER);
	flash(topRect(target));
	return { ok: true, detail: `Hovering ${label(target)}.` };
}

export function click({ ref: name, x, y, button = "left", count = 1, modifiers = [] }: Args<"page_click">) {
	recordBefore();
	if (name !== undefined && (x !== undefined || y !== undefined)) throw new Error("Pass either ref or x and y, not both.");
	if (name === undefined && (x === undefined || y === undefined)) throw new Error("Pass a ref, or x and y together.");
	let target: Element;
	let at: { x: number; y: number } | undefined;
	if (name !== undefined) {
		target = element(name);
		target.scrollIntoView({ block: "center", inline: "nearest" });
	} else {
		if (x! < 0 || y! < 0 || x! >= innerWidth || y! >= innerHeight) {
			throw new Error(`The point (${x}, ${y}) is outside the ${innerWidth}×${innerHeight} viewport.`);
		}
		const found = atPoint(x!, y!);
		if (!found) throw new Error(`Nothing is at (${x}, ${y}).`);
		target = found.element;
		at = { x: found.x, y: found.y };
	}
	if (isDisabled(target)) throw new Error(`${label(target)} is disabled.`);
	const press: Press = { at, modifiers };
	const marker = () => flash(name === undefined ? { x: x!, y: y!, width: 0, height: 0 } : topRect(target), name === undefined);
	if (button === "right" || button === "middle") {
		const right = button === "right";
		if (right) point(target, HOVER, press);
		point(target, ["pointerdown", "mousedown"], { ...press, button: right ? 2 : 1, buttons: right ? 2 : 4 });
		point(target, ["pointerup", "mouseup"], { ...press, button: right ? 2 : 1 });
		point(target, [right ? "contextmenu" : "auxclick"], { ...press, button: right ? 2 : 1 });
		marker();
		return { ok: true, detail: `${right ? "Right-clicked" : "Middle-clicked"} ${label(target)}.` };
	}
	// Widgets that open on press (menus, comboboxes) listen for these, not for `click`.
	point(target, HOVER, press);
	let coveredBy: Element | null = null;
	for (let tap = 1; tap <= count; tap++) {
		const up = { ...press, button: 0, detail: tap };
		if (point(target, ["pointerdown", "mousedown"], { ...up, buttons: 1 }) && isHtml(target)) target.focus({ preventScroll: true });
		point(target, ["pointerup", "mouseup"], up);
		if (tap > 1) {
			point(target, ["click"], up);
			if (tap === 2) point(target, ["dblclick"], up);
			continue;
		}
		const spot = at ?? center(target);
		const scope = target.getRootNode() as Document | ShadowRoot;
		const top = typeof scope.elementFromPoint === "function" ? scope.elementFromPoint(spot.x, spot.y) : document.elementFromPoint(spot.x, spot.y);
		coveredBy = top !== null && top !== target && !target.contains(top) && !top.contains(target) ? top : null;
		// The activation itself: follows links, toggles checkboxes and submits forms as a user's click does.
		if (isHtml(target)) target.click();
		else target.dispatchEvent(new (own(target).MouseEvent)("click", { bubbles: true, cancelable: true, composed: true }));
	}
	marker();
	const clicked = count === 1 ? `Clicked ${label(target)}.` : `Clicked ${label(target)} ${count} times.`;
	return { ok: true, detail: `${clicked}${coveredBy ? ` A ${tagOf(coveredBy)} element covers it: if nothing changed, deal with that one first.` : ""}` };
}

function key(target: Element, name: string, modifiers: readonly string[] = []) {
	const win = own(target);
	const init = {
		key: name, code: /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : name === " " ? "Space" : name,
		bubbles: true, cancelable: true, composed: true, view: win,
		altKey: modifiers.includes("Alt"), ctrlKey: modifiers.includes("Control"), metaKey: modifiers.includes("Meta"), shiftKey: modifiers.includes("Shift"),
	};
	const down = target.dispatchEvent(new win.KeyboardEvent("keydown", init));
	const pressed = down && (name.length > 1 && name !== "Enter" || target.dispatchEvent(new win.KeyboardEvent("keypress", init)));
	target.dispatchEvent(new win.KeyboardEvent("keyup", init));
	return pressed;
}

/** What the browser does for a real Enter or Space, which a scripted key event does not trigger. */
function activate(target: Element, name: string) {
	if (name !== "Enter" && name !== " ") return;
	const type = inputType(target);
	const toggle = type === "checkbox" || type === "radio";
	const button = isButton(target) || isAnchor(target) || target.tagName === "SUMMARY"
		|| (type !== undefined && CAPTIONED.has(type)) || target.getAttribute("role") === "button";
	if (button || (toggle && name === " ")) {
		if (isHtml(target)) target.click();
	} else if (name === "Enter" && isInput(target)) target.form?.requestSubmit();
}

export function press({ key: name, ref, modifiers = [] }: Args<"page_press">) {
	recordBefore();
	const target = ref !== undefined ? element(ref) : document.activeElement ?? document.body;
	if (ref !== undefined) {
		if (isHtml(target)) target.focus({ preventScroll: true });
		flash(topRect(target));
	}
	const pressed = name === "Space" ? " " : name;
	if (key(target, pressed, modifiers) && !modifiers.length) activate(target, pressed);
	return { ok: true, detail: `Pressed ${[...modifiers, name].join("+")} on ${label(target)}.` };
}

const UNTYPABLE = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color", "hidden"]);

/** What a field holds after an action: its value, its editable text or its selected option's text. */
function fieldValue(target: Element): string {
	return isSelect(target) ? (target.selectedOptions[0]?.text ?? "")
		: isInput(target) || isTextArea(target) ? target.value
		: isHtml(target) && target.isContentEditable ? textOf(target)
		: "";
}

/** A field's value after an action, and a note when the page did not keep what was given. */
export function readback(actual: string, requested: string): { value: string; note?: string } {
	const [value] = clip(squash(actual), LIMITS.name);
	if (squash(actual) === squash(requested)) return { value };
	return { value, note: `The field now holds "${value}": the page may have reformatted or rejected it.` };
}

const FIELDS = "input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true]";

/** The field an element is — or the first usable one it hosts, when a ref names a page component. */
function fieldFor(target: Element): Element {
	if (isSelect(target)) throw new Error(`${label(target)} is a dropdown: choose an option with page_select.`);
	if (isInput(target) && UNTYPABLE.has(target.type)) throw new Error(`${label(target)} takes no text: use page_click.`);
	if (isInput(target) || isTextArea(target) || (isHtml(target) && target.isContentEditable)) return target;
	for (const each of deepMatching(target, FIELDS)) {
		if (isInput(each) && UNTYPABLE.has(each.type)) continue;
		if (isDisabled(each) || (each as HTMLInputElement).readOnly) continue;
		return each;
	}
	throw new Error(`${label(target)} is not a text field.`);
}

export function type({ ref, text, submit }: Args<"page_type">) {
	recordBefore();
	const target = fieldFor(element(ref)) as HTMLElement;
	if (isDisabled(target) || (target as HTMLInputElement).readOnly) throw new Error(`${label(target)} is read-only.`);
	target.scrollIntoView({ block: "center", inline: "nearest" });
	target.focus({ preventScroll: true });
	const win = own(target);
	if (isInput(target) || isTextArea(target)) {
		// The native setter, so frameworks that track the value see the change.
		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
		setter?.call(target, text);
		target.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		target.dispatchEvent(new win.Event("change", { bubbles: true }));
	} else if (target.isContentEditable) {
		// Through the editing command: rich-text editors keep their own model and ignore a replaced `textContent`.
		win.getSelection()?.selectAllChildren(target);
		if (!target.ownerDocument.execCommand("insertText", false, text)) {
			target.textContent = text;
			target.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		}
	}
	flash(topRect(target));
	// Read back before the Enter: a form that clears the field on submit must not read as a rejection.
	// A password field reports nothing: what was typed into it must not reach the model.
	const back = isInput(target) && target.type === "password" ? undefined : readback(fieldValue(target), text);
	if (submit && key(target, "Enter")) activate(target, "Enter");
	return {
		ok: true,
		detail: `Typed into ${label(target)}.${back?.note ? ` ${back.note}` : ""}`,
		...(back === undefined ? {} : { value: back.value }),
	};
}

export function select({ ref, option }: Args<"page_select">) {
	recordBefore();
	const target = element(ref);
	if (!isSelect(target)) throw new Error(`${label(target)} is not a <select>: open it with page_click and click the option.`);
	if (isDisabled(target)) throw new Error(`${label(target)} is disabled.`);
	const options = [...target.options].filter((each) => !each.disabled);
	const wanted = squash(option);
	const found = options.find((each) => each.value === option) ?? options.find((each) => squash(each.text) === wanted)
		?? options.find((each) => squash(each.text).toLowerCase() === wanted.toLowerCase());
	if (!found) {
		const [shown, more] = take(options.map((each) => squash(each.text)), 30);
		throw new Error(`${label(target)} has no option "${option}". Options: ${shown.join(" | ")}${more ? " | …" : ""}`);
	}
	target.focus({ preventScroll: true });
	found.selected = true;
	const win = own(target);
	target.dispatchEvent(new win.Event("input", { bubbles: true }));
	target.dispatchEvent(new win.Event("change", { bubbles: true }));
	flash(topRect(target));
	const back = readback(fieldValue(target), found.text);
	return { ok: true, detail: `Selected "${squash(found.text)}" in ${label(target)}.${back.note ? ` ${back.note}` : ""}`, value: back.value };
}

/** The file input a ref names: itself, a label's control, or the first it contains (components and frames included). */
function fileInputOf(target: Element): HTMLInputElement {
	if (isInput(target) && target.type === "file") return target;
	const controlled = target.localName === "label" ? (target as HTMLLabelElement).control : null;
	if (controlled && isInput(controlled) && controlled.type === "file") return controlled;
	for (const each of deepMatching(target, "input[type=file]")) if (isInput(each)) return each;
	throw new Error(`${label(target)} is not a file input: name the input, its label, or the element holding one.`);
}

/** The input's `accept` list: a mismatch is reported, not refused — the files are attached regardless. */
function accepts(input: HTMLInputElement, file: { name: string; type: string }): boolean {
	const accept = input.accept.trim();
	if (!accept) return true;
	const extension = file.name.includes(".") ? `.${file.name.split(".").at(-1)!}`.toLowerCase() : "";
	const type = file.type.toLowerCase();
	return accept.split(",").some((part) => {
		const wanted = part.trim().toLowerCase();
		return wanted === extension || (wanted.endsWith("/*") && type.startsWith(wanted.slice(0, -1))) || type === wanted;
	});
}

export function upload({ ref: name, files }: UploadArgs) {
	recordBefore();
	const input = fileInputOf(element(name));
	if (isDisabled(input)) throw new Error(`${label(input)} is disabled.`);
	if (!input.multiple && files.length > 1) throw new Error(`${label(input)} takes a single file: pass just one.`);
	const win = own(input);
	const transfer = new win.DataTransfer();
	const missed = files.filter((file) => !accepts(input, file)).map((file) => file.name);
	for (const file of files) transfer.items.add(new win.File([new Uint8Array(file.data)], file.name, { type: file.type }));
	input.files = transfer.files;
	input.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
	input.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
	flash(topRect(input));
	return {
		ok: true,
		detail:
			`Attached ${files.map((file) => file.name).join(", ")} to ${label(input)}.` +
			(missed.length ? ` ${missed.join(", ")} do not match accept="${input.accept}".` : ""),
	};
}

export function scroll({ ref, pixels }: Args<"page_scroll">) {
	if (ref !== undefined) element(ref).scrollIntoView({ block: "center", inline: "nearest" });
	else window.scrollBy({ top: pixels ?? window.innerHeight * 0.8 });
	return { ok: true, detail: `scrollY=${Math.round(window.scrollY)}` };
}

const WAIT_STEP_MS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function wait({ selector, text, gone = false, timeoutMs = WAIT.default }: Args<"page_wait">) {
	if (selector !== undefined && text !== undefined) throw new Error("Pass either selector or text, not both.");
	if (selector === undefined && text === undefined) {
		await sleep(timeoutMs);
		return { ok: true, detail: `Waited ${timeoutMs} ms.` };
	}
	// An invalid selector fails now, not after the timeout.
	const present = () => selector !== undefined ? matching(selector).some(visible) : textOf(document.body ?? document.documentElement).includes(text!);
	const what = selector ?? `"${text}"`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (present() !== gone) return { ok: true, detail: `${what} ${gone ? "is gone" : "is there"}.` };
		if (Date.now() >= deadline) return { ok: false, detail: `${what} ${gone ? "was still there" : "did not appear"} after ${timeoutMs} ms.` };
		await sleep(WAIT_STEP_MS);
	}
}
