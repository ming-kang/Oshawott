import { h } from "./ui.ts";

const MAX_HIGHLIGHT = 64_000;
let highlighter: Promise<typeof import("./markdown-highlight.ts")> | undefined;
const revisions = new WeakMap<HTMLElement, number>();

/** Plain text first; swaps in escaped highlight.js markup once the grammars load. Latest write wins. */
export function highlightInto(code: HTMLElement, source: string, language: string | undefined) {
	if (!language || source.length > MAX_HIGHLIGHT) return;
	const revision = (revisions.get(code) ?? 0) + 1;
	revisions.set(code, revision);
	void (highlighter ??= import("./markdown-highlight.ts").catch((error) => { highlighter = undefined; throw error; })).then(({ highlight }) => {
		if (revisions.get(code) !== revision) return;
		const markup = highlight(source, language);
		if (markup === undefined) return;
		// Only highlight.js-generated, escaped markup enters this inert template.
		const template = h("template");
		template.innerHTML = markup;
		code.replaceChildren(...template.content.childNodes);
		code.classList.add("hljs");
	}).catch(() => { /* The already visible source is the fallback. */ });
}

/** A `pre > code` pair showing `source`, highlighted lazily when a language is known. */
export function codeBlock(source: string, language?: string, className?: string) {
	const code = h("code");
	code.textContent = source;
	const pre = h("pre", { class: className ?? null }, code);
	highlightInto(code, source, language);
	return pre;
}
