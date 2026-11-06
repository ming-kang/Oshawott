// The page tools' DOM side. Refs are kept in this content script's memory (never written into the page's DOM), and
// last until the next snapshot or a navigation (which ends this script).
import type { Static } from "../lib/chord.ts";
import type { PageToolArgs as Args, SnapshotResult } from "../tools/page-tools.ts";

const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [contenteditable=true], [tabindex]";
const refs = new Map<string, WeakRef<Element>>();

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
	return label.replace(/\s+/g, " ").trim().slice(0, 120);
}

function roleOf(element: Element): string {
	const explicit = element.getAttribute("role");
	if (explicit) return explicit;
	const tag = element.tagName.toLowerCase();
	if (tag === "a") return "link";
	if (tag === "input") return `input:${(element as HTMLInputElement).type || "text"}`;
	return tag;
}

function element(ref: string): Element {
	const found = refs.get(ref)?.deref();
	if (!found?.isConnected) throw new Error(`No element ${ref}: take a new snapshot.`);
	return found;
}

export function snapshot({ maxChars = 20_000 }: Args<"page_snapshot">): Static<typeof SnapshotResult> {
	refs.clear();
	const elements = [];
	for (const candidate of document.querySelectorAll(INTERACTIVE)) {
		if (!visible(candidate)) continue;
		const ref = `e${refs.size + 1}`;
		refs.set(ref, new WeakRef(candidate));
		elements.push({ ref, role: roleOf(candidate), name: nameOf(candidate) });
		if (elements.length >= 500) break;
	}
	const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
	return {
		url: location.href,
		title: document.title,
		text: text.slice(0, maxChars),
		truncated: text.length > maxChars,
		elements,
	};
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
