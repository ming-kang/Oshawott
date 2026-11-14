import type { MathBlockNode, MathInlineNode } from "stream-markdown-parser";
import { t } from "./i18n/index.ts";
import { enrich } from "./markdown-enrich.ts";
import { copyButton, h } from "./ui.ts";

let styles: Promise<void> | undefined;
let runtime: Promise<typeof import("katex")> | undefined;

function loadMath() {
	if (!styles) {
		const link = h("link", { rel: "stylesheet", href: new URL("katex.css", document.baseURI).href });
		styles = new Promise<void>((resolve, reject) => {
			link.addEventListener("load", () => resolve(), { once: true });
			link.addEventListener("error", () => { link.remove(); styles = undefined; reject(new Error("Math stylesheet unavailable")); }, { once: true });
		});
		document.head.append(link);
	}
	return Promise.all([runtime ??= import("katex").catch((error) => { runtime = undefined; throw error; }), styles]).then(([katex]) => katex);
}

export class MathView {
	readonly element: HTMLElement;
	readonly #body = h("span", { class: "math-body" });
	readonly #display: boolean;
	#source: string | undefined;
	#loading = false;
	#revision = 0;
	#disposed = false;
	#cancel: (() => void) | undefined;

	constructor(display: boolean) {
		this.#display = display;
		this.element = h(display ? "div" : "span", { class: `math math-${display ? "block" : "inline"}` }, this.#body);
		if (display) this.element.append(h("div", { class: "math-actions" }, copyButton(() => this.#source ?? "", t("markdown.copyMath"))));
	}

	update(node: MathInlineNode | MathBlockNode) {
		if (node.content === this.#source && Boolean(node.loading) === this.#loading) return;
		this.#source = node.content;
		this.#loading = Boolean(node.loading);
		const revision = ++this.#revision;
		this.#cancel?.();
		this.#cancel = undefined;
		this.#body.textContent = node.content;
		this.element.removeAttribute("data-rendered");
		this.element.removeAttribute("data-error");
		this.element.toggleAttribute("data-loading", this.#loading);
		if (this.#loading || !node.content) return;
		if (node.content.length > 10_000) {
			this.#fail();
			return;
		}
		void loadMath().then((katex) => {
			if (this.#disposed || revision !== this.#revision) return;
			this.#cancel = enrich(() => {
				this.#cancel = undefined;
				if (this.#disposed || revision !== this.#revision) return;
				try {
					// Fresh macros per expression: model-authored definitions never leak into other blocks.
					katex.render(node.content, this.#body, {
						displayMode: this.#display, output: "htmlAndMathml", throwOnError: true,
						trust: false, strict: "ignore", maxSize: 20, maxExpand: 1000, macros: Object.create(null),
					});
					this.element.setAttribute("data-rendered", "");
					this.element.removeAttribute("title");
				} catch {
					this.#body.textContent = node.content;
					this.#fail();
				}
			});
		}).catch(() => {
			if (!this.#disposed && revision === this.#revision) this.#fail();
		});
	}

	#fail() {
		this.element.setAttribute("data-error", "");
		this.element.title = t("markdown.mathFallback");
	}

	dispose() {
		this.#disposed = true;
		this.#revision++;
		this.#cancel?.();
	}
}
