import type { CodeBlockNode } from "stream-markdown-parser";
import { patchHighlighted, updateText } from "./dom-update.ts";
import { t } from "./i18n/index.ts";
import { enrich } from "./markdown-enrich.ts";
import { copyButton, h, icon } from "./ui.ts";

let highlighter: Promise<typeof import("./markdown-highlight.ts")> | undefined;

export class CodeBlockView {
	readonly element: HTMLElement;
	readonly #label = h("span", { class: "codeblock-language" });
	readonly #status = h("span", { class: "codeblock-live" });
	readonly #code = h("code");
	#text = "";
	#language = "";
	#revision = 0;
	#disposed = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#cancel: (() => void) | undefined;

	constructor() {
		const wrap = h("button", { class: "icon-btn small code-wrap", type: "button", title: t("markdown.wrap"), "aria-label": t("markdown.wrap"), "aria-pressed": "false" }, icon("wrap", 14));
		wrap.addEventListener("click", () => {
			const wrapped = this.element.classList.toggle("wrapped");
			wrap.setAttribute("aria-pressed", String(wrapped));
		});
		const copy = copyButton(() => this.#text, t("copy"));
		copy.classList.add("code-copy");
		this.element = h("div", { class: "codeblock" },
			h("div", { class: "codeblock-head" }, this.#label, this.#status, h("div", { class: "codeblock-actions" }, wrap, copy)),
			h("pre", { tabindex: 0 }, this.#code),
		);
	}

	update(node: CodeBlockNode) {
		const language = node.language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		// The tokenizer includes the line terminator separating the code from its closing fence.
		const text = node.loading ? node.code : node.code.replace(/\n$/, "");
		if (this.#label.textContent !== (language || "text")) this.#label.textContent = language || "text";
		this.element.toggleAttribute("data-loading", Boolean(node.loading));
		this.#status.title = node.loading ? t("markdown.streaming") : "";
		if (text === this.#text && language === this.#language) {
			if (!node.loading && this.#timer !== undefined) {
				clearTimeout(this.#timer);
				this.#timer = undefined;
				this.#highlight();
			}
			return;
		}
		this.#revision++;
		this.#cancel?.();
		this.#cancel = undefined;
		if (language === this.#language && text.startsWith(this.#text) && this.#code.textContent === this.#text && text.length <= 32_000) {
			const tail = text.slice(this.#text.length);
			if (this.#code.lastChild instanceof Text) this.#code.lastChild.appendData(tail);
			else this.#code.append(document.createTextNode(tail));
		} else if (this.#code.childNodes.length === 1 && this.#code.firstChild instanceof Text) updateText(this.#code.firstChild, text);
		else this.#code.replaceChildren(document.createTextNode(text));
		this.#text = text;
		this.#language = language;
		if (!language || text.length > 32_000) return;
		if (!node.loading) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#highlight();
		} else {
			// Throttle, don't debounce: ongoing code streams still receive highlighting.
			this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#highlight(); }, 100);
		}
	}

	#highlight() {
		const revision = this.#revision;
		const text = this.#text;
		const language = this.#language;
		if (!language || text.length > 32_000 || this.#disposed) return;
		void (highlighter ??= import("./markdown-highlight.ts").catch((error) => { highlighter = undefined; throw error; })).then(({ highlight }) => {
			if (this.#disposed || revision !== this.#revision) return;
			this.#cancel = enrich(() => {
				this.#cancel = undefined;
				if (this.#disposed || revision !== this.#revision) return;
				const markup = highlight(text, language);
				if (markup === undefined) return;
				// Only highlight.js-generated, escaped markup enters this inert template.
				const template = h("template");
				template.innerHTML = markup;
				patchHighlighted(this.#code, [...template.content.childNodes]);
				this.#code.classList.add("hljs");
			});
		}).catch(() => { /* The already visible source is the fallback. */ });
	}

	dispose() {
		this.#disposed = true;
		this.#revision++;
		clearTimeout(this.#timer);
		this.#cancel?.();
	}
}
