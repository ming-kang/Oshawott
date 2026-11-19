import { LIMITS } from "../tools/page-limits.ts";
import { clip, squash } from "./limits.ts";
import { RefTable } from "./refs.ts";

export const INTERACTIVE = [
	"a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "[contenteditable=''], [contenteditable=true]", "[onclick]",
	...["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option", "combobox", "textbox"].map((role) => `[role=${role}]`),
	"[tabindex]:not([tabindex='-1'])",
].join(", ");
/** Inputs whose `value` is their caption, not something the user typed. */
export const CAPTIONED = new Set(["submit", "button", "reset"]);

const refs = new RefTable<Element>();
// Same-document navigations between tool calls (Navigation API where the browser has it, and history traversal).
export const observe = () => refs.observe(location.href);
(globalThis as { navigation?: EventTarget }).navigation?.addEventListener("currententrychange", observe);
globalThis.addEventListener?.("popstate", observe);
export const ref = (target: Element) => refs.add(target, location.href);
export const element = (name: string) => refs.resolve(name, location.href);

/** The window an element lives in: frame contents come from another realm, so `instanceof` globals fail on them. */
export const own = (element: Element): Window & typeof globalThis => (element.ownerDocument?.defaultView ?? window) as Window & typeof globalThis;
export const isHtml = (element: Element): element is HTMLElement => element instanceof own(element).HTMLElement;
export const isInput = (element: Element): element is HTMLInputElement => element.localName === "input" && isHtml(element);
export const isSelect = (element: Element): element is HTMLSelectElement => element.localName === "select" && isHtml(element);
export const isTextArea = (element: Element): element is HTMLTextAreaElement => element.localName === "textarea" && isHtml(element);
export const isAnchor = (element: Element): element is HTMLAnchorElement => element.localName === "a" && isHtml(element);
export const isButton = (element: Element): element is HTMLButtonElement => element.localName === "button" && isHtml(element);
export const isTable = (element: Element): element is HTMLTableElement => element.localName === "table" && isHtml(element);

export function visible(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return false;
	const style = own(element).getComputedStyle(element);
	return style.visibility !== "hidden" && style.display !== "none";
}

export const inputType = (element: Element) => isInput(element) ? element.type : undefined;

export function nameOf(element: Element): string {
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

export const isDisabled = (element: Element) => element.matches(":disabled") || element.getAttribute("aria-disabled") === "true";

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

export function roleOf(element: Element): string {
	const explicit = element.getAttribute("role");
	if (explicit) return clip(explicit, LIMITS.name)[0];
	const tag = element.tagName.toLowerCase();
	if (tag === "a") return "link";
	if (isInput(element)) return `input:${element.type || "text"}`;
	return clip(tag, LIMITS.name)[0];
}

export const tagOf = (element: Element) => clip(element.tagName.toLowerCase(), LIMITS.name)[0];

export const textOf = (element: Element) => (isHtml(element) ? element.innerText : element.textContent) ?? "";

export const HIGHLIGHT_TAG = "oshawott-highlight";

// A content script reaches closed shadow roots only through these extension-only accessors.
export function shadowOf(element: Element): ShadowRoot | null {
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
export function frameDoc(element: Element): Document | null {
	if (element.localName !== "iframe" && element.localName !== "frame") return null;
	try {
		return (element as HTMLIFrameElement).contentDocument ?? null;
	} catch {
		return null;
	}
}

/** `root` and every element under it in document order, descending into shadow roots and same-origin frames. */
export function* deep(root: Element): Generator<Element> {
	if (root.localName === HIGHLIGHT_TAG) return;
	yield root;
	const shadow = shadowOf(root);
	if (shadow) for (const child of shadow.children) yield* deep(child);
	for (const child of root.children) yield* deep(child);
	const frame = frameDoc(root);
	if (frame?.documentElement) yield* deep(frame.documentElement);
}

export function* deepMatching(root: Element, selector: string): Generator<Element> {
	for (const candidate of deep(root)) if (candidate.matches(selector)) yield candidate;
}

/** The parent across shadow and frame boundaries, where `parentElement` stops. */
export const parentOf = (element: Element): Element | null => {
	if (element.parentElement) return element.parentElement;
	const root = element.getRootNode();
	return (root as ShadowRoot).host ?? (root as Document).defaultView?.frameElement ?? null;
};

/** An element's rect in top-viewport CSS pixels: the space page_screenshot regions and coordinate clicks use. */
export function topRect(element: Element) {
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

export const onscreen = (box: { x: number; y: number; width: number; height: number }) =>
	box.x + box.width > 0 && box.y + box.height > 0 && box.x < innerWidth && box.y < innerHeight;

/** The element line a snapshot element, an `appeared` entry and an action `target` share. */
export function lineOf(element: Element) {
	return {
		ref: ref(element), role: roleOf(element), name: nameOf(element), ...stateOf(element),
		...(onscreen(topRect(element)) ? {} : { offscreen: true }),
	};
}

export function matching(selector: string): Element[] {
	try {
		return [...document.querySelectorAll(selector)];
	} catch {
		throw new Error(`Invalid CSS selector: ${selector}`);
	}
}

/** The deepest element at a top-viewport point — through shadow roots and same-origin frames — in its document's coordinates. */
export function atPoint(x: number, y: number): { element: Element; x: number; y: number } | null {
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

export const peek = (name: string) => refs.peek(name, location.href);
