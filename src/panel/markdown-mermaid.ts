import type { Mermaid } from "mermaid";
import { type FenceEnricher, type FenceHost, registerFence } from "./markdown-fences.ts";
import { t } from "./i18n/index.ts";
import { h } from "./ui.ts";

/**
 * The Mermaid fence enricher. Mermaid is imported lazily so it ships as its own chunk and loads
 * only when a ```mermaid fence actually finalizes; the bundled grammar renders entirely locally,
 * with no remote CDN or font fetch. Diagram source is model-authored, so it is parsed with
 * Mermaid's `strict` security level and the resulting SVG is re-checked before it enters the DOM.
 * Any failure keeps the plain source visible, so the panel never depends on Mermaid succeeding.
 *
 * CSP: Mermaid 12 renders through DOM/SVG APIs, not `eval`/`new Function`, on the standard diagram
 * path (its bundled d3-dsv CSV helper is the only `new Function`, and Mermaid never calls it). The
 * panel CSP stays `script-src 'self'` with no `unsafe-eval`; a CSP-blocked render just falls back.
 */

/** Mermaid diagrams beyond this size keep the plain code display: layout and sanitization get expensive. */
const MAX_SOURCE = 20_000;
let nextId = 0;

let runtime: Promise<Mermaid> | undefined;

function loadMermaid(): Promise<Mermaid> {
	runtime ??= import("mermaid").then((mod) => {
		// The API is the default export; fall back to the namespace for interop.
		const mermaid = (mod.default ?? mod) as Mermaid;
		mermaid.initialize({
			startOnLoad: false,            // never auto-scan the panel DOM for `.mermaid` nodes
			securityLevel: "strict",       // sanitize model-authored labels; strip scripts, handlers and foreign HTML
			suppressErrorRendering: true,  // surface failures through our own fallback, not an injected error diagram
			htmlLabels: false,             // render labels as SVG text, avoiding foreignObject HTML entirely
			theme: resolvedTheme(),
			// No icon packs, web fonts or CDN URLs are configured: the whole diagram renders from the
			// bundled chunk with only system fonts, so nothing leaves the extension origin.
		});
		return mermaid;
	}).catch((error) => { runtime = undefined; throw error; });
	return runtime;
}

function resolvedTheme(): "dark" | "default" {
	const preference = document.documentElement.dataset.theme;
	const dark = preference === "dark" || (preference !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
	return dark ? "dark" : "default";
}

/**
 * Parse Mermaid's SVG string as XML (never as HTML, and never through `innerHTML`), confirm it is a
 * single SVG root, then strip anything that could execute. Mermaid's `strict` level already
 * sanitizes model-authored labels; this is defense in depth so no script or handler can survive.
 */
function safeDiagram(svg: string): Element {
	const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
	const root = parsed.documentElement;
	if (root.nodeName.toLowerCase() !== "svg") throw new Error("Mermaid produced no SVG");
	stripUnsafe(root);
	return root;
}

function stripUnsafe(node: Element) {
	const tag = node.tagName.toLowerCase();
	// Diagram labels are SVG text, never embedded documents. Remote SVG images would also
	// bypass the Markdown image-by-image consent rule, so they are not part of this format.
	if (["script", "foreignobject", "iframe", "object", "embed", "image"].includes(tag)) { node.remove(); return; }
	for (const attribute of [...node.attributes]) {
		const name = attribute.name.toLowerCase();
		const value = attribute.value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
		if (name.startsWith("on") || ((name === "href" || name === "xlink:href") && value.startsWith("javascript:"))) node.removeAttribute(attribute.name);
		if (name === "style" && /url\s*\(\s*['"]?https?:/i.test(attribute.value)) node.removeAttribute(attribute.name);
	}
	if (tag === "style" && /@import|url\s*\(\s*['"]?https?:/i.test(node.textContent ?? "")) node.remove();
	for (const child of [...node.children]) stripUnsafe(child);
}

class MermaidFence implements FenceEnricher {
	readonly maxLength = MAX_SOURCE;

	render(host: FenceHost): (() => void) | void {
		if (host.source.length > this.maxLength) { host.revert(); return; }
		host.target.replaceChildren(h("div", { class: "mermaid-pending" }, h("span", { class: "spinner" }), t("markdown.diagramRendering")));
		host.reveal();
		let cancelled = false;
		const id = `oshawott-mermaid-${++nextId}`;
		void loadMermaid().then((mermaid) => mermaid.render(id, host.source)).then((result) => {
			const svg: unknown = (result as { svg?: unknown } | undefined)?.svg;
			if (typeof svg !== "string") throw new Error("Mermaid returned no diagram");
			if (cancelled || host.stale()) return;
			host.target.replaceChildren(safeDiagram(svg));
			host.reveal();
		}).catch(() => {
			if (cancelled || host.stale()) return;
			host.revert(true);
		});
		return () => { cancelled = true; };
	}
}

registerFence("mermaid", new MermaidFence());
