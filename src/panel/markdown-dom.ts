// DOM for the Markdown tree of `markdown.ts`: elements and text nodes only, links opened in a new tab without an opener.
import { t } from "./i18n.ts";
import { type Block, closeDangling, type Inline, parseMarkdown } from "./markdown.ts";
import { copyText, h, icon } from "./ui.ts";

function inline(nodes: readonly Inline[], inLink = false): Node[] {
	return nodes.map((node): Node => {
		switch (node.t) {
			case "text":
				return document.createTextNode(node.text);
			case "br":
				return h("br");
			case "code":
				return h("code", null, node.text);
			case "strong":
				return h("strong", null, inline(node.children, inLink));
			case "em":
				return h("em", null, inline(node.children, inLink));
			case "del":
				return h("del", null, inline(node.children, inLink));
			case "link":
				// A link inside a link's label stays text: anchors do not nest.
				if (inLink) return h("span", null, inline(node.children, true));
				return h("a", { href: node.href, target: "_blank", rel: "noopener noreferrer", title: node.href }, inline(node.children, true));
		}
	});
}

export function codeBlock(text: string, lang = "") {
	const button = h("button", { class: "icon-btn small", type: "button", title: t("copy"), "aria-label": t("copy") }, icon("copy", 14));
	button.addEventListener("click", async () => {
		if (await copyText(text)) {
			button.replaceChildren(icon("check", 14));
			setTimeout(() => button.replaceChildren(icon("copy", 14)), 1200);
		}
	});
	return h(
		"div",
		{ class: "codeblock" },
		h("div", { class: "codeblock-head" }, h("span", null, lang || "text"), button),
		h("pre", null, h("code", null, text)),
	);
}

function block(node: Block): Node {
	switch (node.t) {
		case "p":
			return h("p", null, inline(node.children));
		case "h":
			return h(`h${Math.min(node.level + 1, 6)}` as "h2", null, inline(node.children));
		case "code":
			return codeBlock(node.text, node.lang);
		case "quote":
			return h("blockquote", null, node.children.map(block));
		case "hr":
			return h("hr");
		case "list": {
			const items = node.items.map((item) => h("li", null, item.map(block)));
			return node.ordered && node.start !== 1 ? h("ol", { start: node.start }, items) : h(node.ordered ? "ol" : "ul", null, items);
		}
		case "table":
			return h(
				"div",
				{ class: "table-wrap" },
				h(
					"table",
					null,
					h("thead", null, h("tr", null, node.head.map((cell, c) => h("th", { style: node.align[c] ? `text-align:${node.align[c]}` : null }, inline(cell))))),
					h(
						"tbody",
						null,
						node.rows.map((row) => h("tr", null, row.map((cell, c) => h("td", { style: node.align[c] ? `text-align:${node.align[c]}` : null }, inline(cell))))),
					),
				),
			);
	}
}

/** Markdown as a `.md` element; `streaming` closes dangling spans and adds the caret after the last text. */
export function markdown(source: string, streaming = false): HTMLElement {
	const root = h("div", { class: "md" }, parseMarkdown(streaming ? closeDangling(source) : source).map(block));
	if (streaming) {
		let last: Element = root;
		while (last.lastElementChild && !["BR", "HR"].includes(last.lastElementChild.tagName) && !last.lastElementChild.classList.contains("codeblock-head")) {
			last = last.lastElementChild;
		}
		if (last.classList.contains("codeblock")) last = last.querySelector("code") ?? last;
		last.appendChild(h("span", { class: "caret", "aria-hidden": "true" }));
	}
	return root;
}
