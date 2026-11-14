import type {
	AdmonitionNode, BlockquoteNode, CheckboxInputNode, CheckboxNode, CodeBlockNode, DefinitionItemNode, DefinitionListNode,
	EmphasisNode, EmojiNode, FootnoteAnchorNode, FootnoteNode, FootnoteReferenceNode, HardBreakNode, HeadingNode,
	HighlightNode, HtmlBlockNode, HtmlInlineNode, ImageNode, InlineCodeNode, InlineNode, InsertNode, LinkNode, ListItemNode,
	ListNode, MathBlockNode, MathInlineNode, ParagraphNode, ParsedNode, StrikethroughNode, StrongNode, SubscriptNode,
	SuperscriptNode, TableCellNode, TableNode, TableRowNode, TextNode, ThematicBreakNode, VmrContainerNode,
} from "stream-markdown-parser";
import { reconcileChildren, updateText } from "./dom-update.ts";
import { t } from "./i18n/index.ts";
import { CodeBlockView } from "./markdown-code.ts";
import { MathView } from "./markdown-math.ts";
import { parseMarkdown, safeImageUrl, safeUrl } from "./markdown.ts";
import { h, icon } from "./ui.ts";

// The upstream union includes arbitrary extension nodes with `type: string`.
// Narrow once at dispatch; unsupported extensions always fall back to literal text.
type BuiltinNode = TextNode | ParagraphNode | HeadingNode | InlineNode | CodeBlockNode | InlineCodeNode | ListNode | ListItemNode
	| BlockquoteNode | TableNode | TableRowNode | TableCellNode | StrongNode | EmphasisNode | StrikethroughNode | HighlightNode
	| InsertNode | SubscriptNode | SuperscriptNode | LinkNode | ImageNode | ThematicBreakNode | HardBreakNode | MathInlineNode | MathBlockNode
	| CheckboxNode | CheckboxInputNode | HtmlBlockNode | HtmlInlineNode | FootnoteNode | FootnoteReferenceNode | FootnoteAnchorNode
	| DefinitionListNode | DefinitionItemNode | AdmonitionNode | VmrContainerNode | EmojiNode;

type Context = { root: HTMLElement; prefix: string; inLink?: boolean };
interface View { element: Node; update(node: ParsedNode): void; dispose(): void }

function bind<T>(element: Node, update: (node: T) => void, dispose = () => {}): View {
	return { element, update: (node) => update(node as T), dispose };
}

function keyOf(node: ParsedNode, index: number): string {
	const n = node as BuiltinNode;
	switch (n.type) {
		case "footnote": return `footnote:${n.id}`;
		case "heading": return `${index}:heading:${n.level}`;
		case "list": return `${index}:list:${n.ordered}`;
		case "table_cell": return `${index}:cell:${n.header}`;
		case "link": return `${index}:link:${n.markup === "html" ? "html" : n.loading || !safeUrl(n.href) ? "pending" : "resolved"}`;
		default: return `${index}:${node.type}`;
	}
}

class NodeList {
	readonly #parent: Node;
	readonly #context: Context;
	#views = new Map<string, View>();

	constructor(parent: Node, context: Context) { this.#parent = parent; this.#context = context; }

	update(nodes: readonly ParsedNode[]) {
		const next = new Map<string, View>();
		for (const [index, node] of nodes.entries()) {
			const key = keyOf(node, index);
			const view = this.#views.get(key) ?? render(node, this.#context);
			view.update(node);
			next.set(key, view);
		}
		for (const [key, view] of this.#views) if (!next.has(key)) view.dispose();
		this.#views = next;
		reconcileChildren(this.#parent, [...next.values()].map((view) => view.element));
	}

	dispose() { for (const view of this.#views.values()) view.dispose(); this.#views.clear(); }
}

function container<T>(element: HTMLElement, context: Context, children: (node: T) => readonly ParsedNode[], attrs?: (element: HTMLElement, node: T) => void): View {
	const list = new NodeList(element, context);
	return bind<T>(element, (node) => { list.update(children(node)); attrs?.(element, node); }, () => list.dispose());
}

function attr(element: HTMLElement, name: string, value: string) {
	if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function literal(value: (node: ParsedNode) => string): View {
	const text = document.createTextNode("");
	return bind(text, (node: ParsedNode) => updateText(text, value(node)));
}

class ImageView {
	readonly element = h("span", { class: "md-image" });
	readonly #button = h("button", { class: "md-image-load", type: "button" }, icon("eye", 14));
	readonly #label = h("span");
	#src: string | undefined;
	#alt = "";
	#loaded = false;
	#image: HTMLImageElement | undefined;

	constructor() {
		this.#button.append(this.#label);
		this.#button.addEventListener("click", () => {
			if (!this.#src) return;
			this.#loaded = true;
			const image = h("img", { src: this.#src, alt: this.#alt, referrerpolicy: "no-referrer", loading: "lazy", decoding: "async" });
			this.#image = image;
			image.addEventListener("error", () => {
				if (this.#image !== image) return;
				this.#loaded = false;
				this.#button.title = t("markdown.imageFailed");
				this.element.replaceChildren(this.#button);
			});
			this.element.replaceChildren(image);
		});
	}

	update(node: ImageNode) {
		const src = !node.loading ? safeImageUrl(node.src) : undefined;
		if (src !== this.#src) { this.#loaded = false; this.#image = undefined; }
		this.#src = src;
		this.#alt = node.alt;
		this.#label.textContent = `${node.alt ? `${node.alt} · ` : ""}${t("markdown.loadImage")}`;
		this.#button.title = src ?? node.alt;
		this.#button.disabled = !src;
		if (this.#loaded && this.#image) this.#image.alt = node.alt;
		else reconcileChildren(this.element, [this.#button]);
	}
}

function render(data: ParsedNode, context: Context): View {
	const node = data as BuiltinNode;
	switch (node.type) {
		case "text": return literal((n) => (n as TextNode).content);
		case "paragraph": return container<ParagraphNode>(h("p"), context, (n) => n.children);
		case "inline": return container<InlineNode>(h("span"), context, (n) => n.children);
		case "heading": return container<HeadingNode>(h(`h${Math.min(node.level + 1, 6)}` as "h2"), context, (n) => n.children);
		case "strong": return container<StrongNode>(h("strong"), context, (n) => n.children);
		case "emphasis": return container<EmphasisNode>(h("em"), context, (n) => n.children);
		case "strikethrough": return container<StrikethroughNode>(h("del"), context, (n) => n.children);
		case "highlight": return container<HighlightNode>(h("mark"), context, (n) => n.children);
		case "insert": return container<InsertNode>(h("ins"), context, (n) => n.children);
		case "subscript": return container<SubscriptNode>(h("sub"), context, (n) => n.children);
		case "superscript": return container<SuperscriptNode>(h("sup"), context, (n) => n.children);
		case "inline_code": {
			const text = document.createTextNode("");
			return bind<InlineCodeNode>(h("code", null, text), (n) => updateText(text, n.code));
		}
		case "code_block": {
			const code = new CodeBlockView();
			return bind<CodeBlockNode>(code.element, (n) => code.update(n), () => code.dispose());
		}
		case "math_inline":
		case "math_block": {
			const math = new MathView(node.type === "math_block");
			return bind<MathInlineNode | MathBlockNode>(math.element, (n) => math.update(n), () => math.dispose());
		}
		case "link": {
			if (node.markup === "html") return literal((n) => n.raw);
			if (context.inLink || node.loading || !safeUrl(node.href)) return container<LinkNode>(h("span", { class: "md-link-pending" }), context, (n) => n.children);
			return container<LinkNode>(h("a", { target: "_blank", rel: "noopener noreferrer" }), { ...context, inLink: true }, (n) => n.children, (element, n) => {
				attr(element, "href", safeUrl(n.href)!);
				attr(element, "title", n.title || n.href);
			});
		}
		case "image": {
			const image = new ImageView();
			return bind<ImageNode>(image.element, (n) => image.update(n));
		}
		case "blockquote": return container<BlockquoteNode>(h("blockquote"), context, (n) => n.children);
		case "thematic_break": return bind(h("hr"), () => {});
		case "hardbreak": return bind(h("br"), () => {});
		case "list": return container<ListNode>(h(node.ordered ? "ol" : "ul"), context, (n) => n.items, (element, n) => {
			if (n.ordered) attr(element, "start", String(n.start ?? 1));
		});
		case "list_item": return container<ListItemNode>(h("li"), context, (n) => n.children, (element) => {
			element.classList.toggle("task-list-item", Boolean(element.querySelector(":scope > p > .md-task-checkbox")));
		});
		case "checkbox":
		case "checkbox_input": {
			const checkbox = h("input", { type: "checkbox", class: "md-task-checkbox", disabled: true });
			return bind<CheckboxNode | CheckboxInputNode>(checkbox, (n) => {
				checkbox.checked = n.checked;
				attr(checkbox, "aria-label", t(n.checked ? "markdown.taskDone" : "markdown.taskPending"));
			});
		}
		case "table": {
			const head = h("thead");
			const body = h("tbody");
			const headers = new NodeList(head, context);
			const rows = new NodeList(body, context);
			const wrap = h("div", { class: "table-wrap", tabindex: 0, role: "region", "aria-label": t("markdown.table") }, h("table", null, head, body));
			return bind<TableNode>(wrap, (n) => { headers.update([n.header]); rows.update(n.rows); }, () => { headers.dispose(); rows.dispose(); });
		}
		case "table_row": return container<TableRowNode>(h("tr"), context, (n) => n.cells);
		case "table_cell": return container<TableCellNode>(h(node.header ? "th" : "td", { scope: node.header ? "col" : null }), context, (n) => n.children, (element, n) => {
			const align = n.align ?? "left";
			if (element.style.textAlign !== align) element.style.textAlign = align;
		});
		case "admonition": {
			const title = h("strong");
			const body = h("div");
			const children = new NodeList(body, context);
			const element = h("aside", { class: "md-admonition" }, h("div", { class: "md-admonition-title" }, icon("bulb", 15), title), body);
			return bind<AdmonitionNode>(element, (n) => {
				attr(element, "data-kind", n.kind);
				if (title.textContent !== (n.title || n.kind)) title.textContent = n.title || n.kind;
				children.update(n.children);
			}, () => children.dispose());
		}
		case "vmr_container": return container<VmrContainerNode>(h("div"), context, (n) => n.children);
		case "definition_list": return container<DefinitionListNode>(h("dl"), context, (n) => n.items);
		case "definition_item": {
			const term = h("dt");
			const description = h("dd");
			const terms = new NodeList(term, context);
			const definitions = new NodeList(description, context);
			return bind<DefinitionItemNode>(h("div", null, term, description), (n) => { terms.update(n.term); definitions.update(n.definition); }, () => { terms.dispose(); definitions.dispose(); });
		}
		case "footnote": {
			const label = h("span", { class: "md-footnote-label" });
			const body = h("div");
			const children = new NodeList(body, context);
			const element = h("div", { class: "md-footnote", role: "note", tabindex: -1 }, label, body);
			return bind<FootnoteNode>(element, (n) => {
				attr(element, "id", noteId(context, n.id));
				if (label.textContent !== `[${n.id}]`) label.textContent = `[${n.id}]`;
				children.update(n.children);
			}, () => children.dispose());
		}
		case "footnote_reference": {
			const link = h("a", { class: "md-footnote-ref" });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				const target = context.root.querySelector<HTMLElement>(`#${CSS.escape(noteId(context, link.dataset.footnote!))}`);
				target?.scrollIntoView({ block: "nearest" });
				target?.focus({ preventScroll: true });
			});
			return bind<FootnoteReferenceNode>(h("sup", null, link), (n) => {
				attr(link, "data-footnote", n.id);
				attr(link, "href", `#${noteId(context, n.id)}`);
				attr(link, "aria-label", t("markdown.footnote", n.id));
				if (link.textContent !== `[${n.id}]`) link.textContent = `[${n.id}]`;
			});
		}
		case "footnote_anchor": {
			const link = h("a", { class: "md-footnote-back", href: "#", "aria-label": t("markdown.footnoteBack") }, "↩");
			link.addEventListener("click", (event) => {
				event.preventDefault();
				const target = [...context.root.querySelectorAll<HTMLAnchorElement>(".md-footnote-ref")].find((ref) => ref.dataset.footnote === link.dataset.footnote);
				target?.scrollIntoView({ block: "nearest" });
				target?.focus({ preventScroll: true });
			});
			return bind<FootnoteAnchorNode>(link, (n) => attr(link, "data-footnote", n.id));
		}
		case "html_block": {
			const text = document.createTextNode("");
			return bind<HtmlBlockNode>(h("pre", { class: "md-raw" }, text), (n) => updateText(text, n.content));
		}
		case "html_inline": return literal((n) => (n as HtmlInlineNode).content);
		default: return literal((n) => n.raw || "");
	}
}

const noteId = (context: Context, id: string) => `${context.prefix}-note-${encodeURIComponent(id)}`;
let nextId = 0;

/** A Markdown document owns its DOM for its entire streaming → committed lifetime. */
export class MarkdownView {
	readonly element = h("div", { class: "md" });
	readonly #nodes = new NodeList(this.element, { root: this.element, prefix: `md-${++nextId}` });
	readonly #caret = h("span", { class: "caret", "aria-hidden": "true" });
	#source: string | undefined;
	#streaming = false;
	#disposed = false;

	constructor(source = "", streaming = false) { this.update(source, streaming); }

	update(source: string, streaming = false) {
		if (this.#disposed || (source === this.#source && streaming === this.#streaming)) return;
		this.#source = source;
		this.#streaming = streaming;
		this.#caret.remove();
		this.#nodes.update(parseMarkdown(source, streaming));
		this.element.toggleAttribute("data-streaming", streaming);
		if (streaming) cursorTarget(this.element).appendChild(this.#caret);
	}

	dispose() { this.#disposed = true; this.#caret.remove(); this.#nodes.dispose(); }
}

function cursorTarget(root: HTMLElement): Element {
	let target: Element = root;
	while (target.lastElementChild) {
		const child = target.lastElementChild;
		if (child.classList.contains("codeblock")) return child.querySelector(".codeblock-live")!;
		// Never place a cursor inside interactive controls, KaTeX's DOM, or a void element.
		if (child.matches("a, button, input, svg, sup, br, hr, .math, .md-image")) break;
		target = child;
	}
	return target.matches("ul, ol, table, thead, tbody, tr, pre") ? root : target;
}
