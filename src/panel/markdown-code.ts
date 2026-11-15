import type { CodeBlockNode } from "stream-markdown-parser";
import { patchHighlighted, updateText } from "./dom-update.ts";
import { fenceEnricher, fenceLanguage } from "./markdown-fences.ts";
import "./markdown-mermaid.ts"; // Registers the built-in fence enrichers (Mermaid) on first code block.
import { t } from "./i18n/index.ts";
import { enrich } from "./markdown-enrich.ts";
import { copyButton, h, icon } from "./ui.ts";

let highlighter: Promise<typeof import("./markdown-highlight.ts")> | undefined;

export class CodeBlockView {
	readonly element: HTMLElement;
	readonly #label = h("span", { class: "codeblock-language" });
	readonly #status = h("span", { class: "codeblock-live" });
	readonly #code = h("code");
	// The plain source display is the always-available fallback; an enricher may swap it for a rendered view.
	readonly #pre = h("pre", { tabindex: 0 }, this.#code);
	readonly #view = h("div", { class: "codeblock-view", hidden: true });
	#text = "";
	#language = "";
	#revision = 0;
	#disposed = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#cancel: (() => void) | undefined;
	#fence: (() => void) | undefined;

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
			this.#pre,
			this.#view,
		);
	}

	update(node: CodeBlockNode) {
		const language = fenceLanguage(node.language);
		// The tokenizer includes the line terminator separating the code from its closing fence.
		const text = node.loading ? node.code : node.code.replace(/\n$/, "");
		const wasLoading = this.element.hasAttribute("data-loading");
		if (this.#label.textContent !== (language || "text")) this.#label.textContent = language || "text";
		this.element.toggleAttribute("data-loading", Boolean(node.loading));
		this.#status.title = node.loading ? t("markdown.streaming") : "";
		if (text === this.#text && language === this.#language) {
			if (!node.loading && (this.#timer !== undefined || wasLoading)) {
				clearTimeout(this.#timer);
				this.#timer = undefined;
				this.#highlight();
				// Closing a fence can leave its source unchanged; finalization, not a text edit,
				// is what starts diagram enrichment.
				if (wasLoading) this.#enrichFence();
			}
			return;
		}
		this.#revision++;
		this.#cancel?.();
		this.#cancel = undefined;
		// Any content or language change discards an in-flight or shown enrichment until it is re-run.
		if (this.#fence !== undefined || this.element.hasAttribute("data-enriched")) this.#revertFence();
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
			this.#enrichFence();
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

	/** Hand the finalized source to the language's enricher, if one is registered and the source is in bounds. */
	#enrichFence() {
		const enricher = fenceEnricher(this.#language);
		if (!enricher || this.#text.length > enricher.maxLength) return;
		const revision = this.#revision;
		this.#fence = enricher.render({
			source: this.#text,
			target: this.#view,
			reveal: () => this.#revealFence(),
			revert: (failed = false) => this.#revertFence(failed),
			stale: () => this.#disposed || this.#revision !== revision,
		}) ?? undefined;
	}

	#revealFence() {
		this.#pre.hidden = true;
		this.#view.hidden = false;
		this.element.setAttribute("data-enriched", "");
	}

	#revertFence(failed = false) {
		this.#fence?.();
		this.#fence = undefined;
		this.#view.replaceChildren();
		this.#view.hidden = true;
		this.#pre.hidden = false;
		this.element.removeAttribute("data-enriched");
		this.element.toggleAttribute("data-error", failed);
		if (failed) this.element.title = t("markdown.diagramFailed");
		else this.element.removeAttribute("title");
	}

	dispose() {
		this.#disposed = true;
		this.#revision++;
		clearTimeout(this.#timer);
		this.#cancel?.();
		this.#fence?.();
	}
}
