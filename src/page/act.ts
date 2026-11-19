import type { UploadArgs } from "../contracts/page.ts";
import { LIMITS } from "../tools/page-limits.ts";
import { type PageToolArgs as Args, WAIT } from "../tools/page-tools.ts";
import { clip, squash, take } from "./limits.ts";
import { atPoint, CAPTIONED, deepMatching, element, HIGHLIGHT_TAG, inputType, INTERACTIVE, isAnchor, isButton, isDisabled, isHtml, isInput, isSelect, isTextArea, lineOf, matching, nameOf, own, peek, roleOf, tagOf, textOf, topRect, visible } from "./tree.ts";

const DIALOGS = "dialog[open], [role=dialog], [role=alertdialog]";
const openDialogs = () => matching(DIALOGS).filter(visible);
/** How many interactive candidates the pre-action scan reads at most. */
const RECORD_SCAN = 5_000;
function recordBefore() {
	const interactive = new Set<Element>();
	let scanned = 0;
	for (const candidate of deepMatching(document.documentElement, INTERACTIVE)) {
		if (++scanned > RECORD_SCAN) break;
		if (visible(candidate)) interactive.add(candidate);
	}
	return { dialogs: new Set(openDialogs()), interactive };
}

function dialogName(dialog: Element): string {
	const labelled = dialog.getAttribute("aria-label")
		?? dialog.querySelector("h1, h2, h3, h4, h5, h6, [role=heading]")?.textContent;
	return clip(squash(labelled ?? ""), LIMITS.name)[0] || nameOf(dialog);
}

/** The state after one action: where the page is, what it opened, what appeared, what the target became. */
function settled(name: string | undefined, before: ReturnType<typeof recordBefore>) {
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
	const target = name === undefined ? undefined : peek(name);
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

const MAX_PENDING_RECEIPTS = 16;
const RECEIPT_TTL_MS = 30_000;

export function actionReceipts() {
	const pending = new Map<string, { before: ReturnType<typeof recordBefore>; timer: ReturnType<typeof setTimeout> }>();
	const forget = (id: string) => {
		const receipt = pending.get(id);
		if (receipt) clearTimeout(receipt.timer);
		pending.delete(id);
		return receipt?.before;
	};
	return {
		run<A extends object, R>(act: (args: A) => R) {
			return async (args: A & { receiptId?: string }) => {
				const { receiptId } = args;
				if (!receiptId) return act(args);
				if (pending.size >= MAX_PENDING_RECEIPTS) forget(pending.keys().next().value!);
				const before = recordBefore();
				const result = act(args);
				forget(receiptId);
				pending.set(receiptId, { before, timer: setTimeout(() => forget(receiptId), RECEIPT_TTL_MS) });
				return result;
			};
		},
		settled({ receiptId, ref }: { receiptId: string; ref?: string }) {
			const before = forget(receiptId);
			return before ? settled(ref, before) : null;
		},
	};
}

const label = (target: Element) => `${roleOf(target)} "${nameOf(target)}"`;

function center(target: Element) {
	const rect = target.getBoundingClientRect();
	return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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
	const target = element(ref);
	target.scrollIntoView({ block: "center", inline: "nearest" });
	point(target, HOVER);
	flash(topRect(target));
	return { ok: true, detail: `Hovering ${label(target)}.` };
}

export function click({ ref: name, x, y, button = "left", count = 1, modifiers = [] }: Args<"page_click">) {
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
