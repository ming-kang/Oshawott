import type { Static } from "../lib/chord.ts";
import { type InspectResult, type PageToolArgs as Args, type SnapshotResult, type Structure, WAIT } from "../tools/page-tools.ts";
import { LIMITS } from "../tools/page-limits.ts";
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
addEventListener("popstate", observe);
const ref = (target: Element) => refs.add(target, location.href);
const element = (name: string) => refs.resolve(name, location.href);

function visible(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return false;
	const style = getComputedStyle(element);
	return style.visibility !== "hidden" && style.display !== "none";
}

const inputType = (element: Element) => element instanceof HTMLInputElement ? element.type : undefined;

/** The first of the element's accessible-name sources that says something. */
function nameOf(element: Element): string {
	const type = inputType(element);
	const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
	// A field's own text is its options or its content, never its name.
	const field = element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement || type !== undefined;
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

/** What a user sees of the element beyond its name. A password's text is never read. */
function stateOf(element: Element) {
	const type = inputType(element);
	const typed = element instanceof HTMLTextAreaElement
		|| (type !== undefined && type !== "password" && type !== "checkbox" && type !== "radio" && !CAPTIONED.has(type));
	const value = squash((element instanceof HTMLSelectElement ? element.selectedOptions[0]?.text : typed ? (element as HTMLInputElement).value : "") ?? "");
	const checked = type === "checkbox" || type === "radio"
		? (element as HTMLInputElement).checked : ariaFlag(element, "aria-checked") ?? ariaFlag(element, "aria-selected");
	const expanded = ariaFlag(element, "aria-expanded");
	const href = element instanceof HTMLAnchorElement ? element.href : "";
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
	if (tag === "input") return `input:${(element as HTMLInputElement).type || "text"}`;
	return clip(tag, LIMITS.name)[0];
}

const tagOf = (element: Element) => clip(element.tagName.toLowerCase(), LIMITS.name)[0];

const textOf = (element: Element) => (element instanceof HTMLElement ? element.innerText : element.textContent) ?? "";

/** `root` and the elements under it matching `selector`, in document order. */
function within(root: Element, selector: string): Element[] {
	return [...(root.matches(selector) ? [root] : []), ...root.querySelectorAll(selector)];
}

function matching(selector: string): Element[] {
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
		elements.push({ ref: ref(candidate), role: roleOf(candidate), name: nameOf(candidate), ...stateOf(candidate) });
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

export function describe({ ref }: { ref: string }) {
	const target = element(ref);
	return { role: roleOf(target), name: nameOf(target) };
}

const label = (target: Element) => `${roleOf(target)} "${nameOf(target)}"`;

function center(target: Element) {
	const rect = target.getBoundingClientRect();
	return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
}

/** Pointer and mouse events at the element's centre; `false` when the page cancelled one. */
function point(target: Element, kinds: readonly string[], buttons = 0) {
	const init = { cancelable: true, composed: true, view: window, button: 0, buttons, ...center(target) };
	let allowed = true;
	for (const kind of kinds) {
		const bubbles = !kind.endsWith("enter");
		const event = kind.startsWith("pointer")
			? new PointerEvent(kind, { ...init, bubbles, pointerId: 1, pointerType: "mouse", isPrimary: true })
			: new MouseEvent(kind, { ...init, bubbles });
		allowed = target.dispatchEvent(event) && allowed;
	}
	return allowed;
}

const HOVER = ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"];

export function hover({ ref }: Args<"page_hover">) {
	const target = element(ref);
	target.scrollIntoView({ block: "center", inline: "nearest" });
	point(target, HOVER);
	return { ok: true, detail: `Hovering ${label(target)}.` };
}

export function click({ ref }: Args<"page_click">) {
	const target = element(ref) as HTMLElement;
	if (isDisabled(target)) throw new Error(`${label(target)} is disabled.`);
	target.scrollIntoView({ block: "center", inline: "nearest" });
	// Widgets that open on press (menus, comboboxes) listen for these, not for `click`.
	point(target, HOVER);
	if (point(target, ["pointerdown", "mousedown"], 1)) target.focus({ preventScroll: true });
	point(target, ["pointerup", "mouseup"]);
	const { clientX, clientY } = center(target);
	const top = document.elementFromPoint(clientX, clientY);
	const covered = top !== null && top !== target && !target.contains(top) && !top.contains(target);
	const done = `Clicked ${label(target)}.${covered ? ` A ${tagOf(top)} element covers it: if nothing changed, deal with that one first.` : ""}`;
	// The activation itself: follows links, toggles checkboxes and submits forms as a user's click does.
	target.click();
	return { ok: true, detail: done };
}

/** Key events on the element; `false` when the page cancelled the key. */
function key(target: Element, name: string, modifiers: readonly string[] = []) {
	const init = {
		key: name, code: /^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : name === " " ? "Space" : name,
		bubbles: true, cancelable: true, composed: true, view: window,
		altKey: modifiers.includes("Alt"), ctrlKey: modifiers.includes("Control"), metaKey: modifiers.includes("Meta"), shiftKey: modifiers.includes("Shift"),
	};
	const down = target.dispatchEvent(new KeyboardEvent("keydown", init));
	const pressed = down && (name.length > 1 && name !== "Enter" || target.dispatchEvent(new KeyboardEvent("keypress", init)));
	target.dispatchEvent(new KeyboardEvent("keyup", init));
	return pressed;
}

/** What the browser does for a real Enter or Space, which a scripted key event does not trigger. */
function activate(target: Element, name: string) {
	if (name !== "Enter" && name !== " ") return;
	const type = inputType(target);
	const toggle = type === "checkbox" || type === "radio";
	const button = target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement || target.tagName === "SUMMARY"
		|| (type !== undefined && CAPTIONED.has(type)) || target.getAttribute("role") === "button";
	if (button || (toggle && name === " ")) (target as HTMLElement).click();
	else if (name === "Enter" && target instanceof HTMLInputElement) target.form?.requestSubmit();
}

export function press({ key: name, ref, modifiers = [] }: Args<"page_press">) {
	const target = ref !== undefined ? element(ref) : document.activeElement ?? document.body;
	if (ref !== undefined && target instanceof HTMLElement) target.focus({ preventScroll: true });
	const pressed = name === "Space" ? " " : name;
	if (key(target, pressed, modifiers) && !modifiers.length) activate(target, pressed);
	return { ok: true, detail: `Pressed ${[...modifiers, name].join("+")} on ${label(target)}.` };
}

const UNTYPABLE = new Set(["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color", "hidden"]);

export function type({ ref, text, submit }: Args<"page_type">) {
	const target = element(ref) as HTMLElement;
	if (target instanceof HTMLSelectElement) throw new Error(`${label(target)} is a dropdown: choose an option with page_select.`);
	if (target instanceof HTMLInputElement && UNTYPABLE.has(target.type)) throw new Error(`${label(target)} takes no text: use page_click.`);
	if (isDisabled(target) || (target as HTMLInputElement).readOnly) throw new Error(`${label(target)} is read-only.`);
	target.scrollIntoView({ block: "center", inline: "nearest" });
	target.focus({ preventScroll: true });
	if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
		// The native setter, so frameworks that track the value see the change.
		const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set;
		setter?.call(target, text);
		target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		target.dispatchEvent(new Event("change", { bubbles: true }));
	} else if (target.isContentEditable) {
		// Through the editing command: rich-text editors keep their own model and ignore a replaced `textContent`.
		getSelection()?.selectAllChildren(target);
		if (!document.execCommand("insertText", false, text)) {
			target.textContent = text;
			target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
		}
	} else throw new Error(`${label(target)} is not a text field.`);
	if (submit && key(target, "Enter")) activate(target, "Enter");
	return { ok: true, detail: `Typed into ${label(target)}.` };
}

export function select({ ref, option }: Args<"page_select">) {
	const target = element(ref);
	if (!(target instanceof HTMLSelectElement)) throw new Error(`${label(target)} is not a <select>: open it with page_click and click the option.`);
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
	target.dispatchEvent(new Event("input", { bubbles: true }));
	target.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true, detail: `Selected "${squash(found.text)}" in ${label(target)}.` };
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
