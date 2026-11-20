import type { AssistantMessage } from "@earendil-works/pi-ai";
import { reconcileChildren } from "./dom-update.ts";
import { t } from "./i18n/index.ts";
import { MarkdownView } from "./markdown-dom.ts";
import { ToolCard } from "./tool-card.ts";
import { h, icon } from "./ui.ts";

type Part =
	| { type: "text"; element: HTMLElement; markdown: MarkdownView }
	| { type: "thinking"; element: HTMLDetailsElement; markdown: MarkdownView; label: HTMLElement }
	| { type: "toolCall"; element: HTMLDetailsElement; card: ToolCard; id: string; name: string };

/** Content parts, disclosures and code controls survive both streaming and finalization. */
export class AssistantView {
	readonly element = h("div", { class: "native-view" });
	#parts = new Map<string, Part>();
	#groups = new Map<number, HTMLElement>();

	get cards(): Map<string, ToolCard> {
		return new Map([...this.#parts.values()].flatMap((part) => part.type === "toolCall" ? [[part.id, part.card] as const] : []));
	}

	update(message: AssistantMessage, live: boolean) {
		const parts = new Map<string, Part>();
		const groups = new Map<number, HTMLElement>();
		const nodes: Node[] = [];
		let group: HTMLElement | undefined;
		let groupCards: Node[] = [];
		let hasTool = false;
		let hasNonTool = false;
		const flushGroup = () => { if (group) reconcileChildren(group, groupCards); group = undefined; groupCards = []; };
		for (const [index, block] of message.content.entries()) {
			const last = index === message.content.length - 1;
			if (block.type !== "toolCall") flushGroup();
			if (block.type === "thinking" && (block.redacted || !block.thinking.trim())) continue;
			if (block.type === "text" && !block.text.trim() && !(live && last)) continue;
			const key = block.type === "toolCall" ? `tool:${block.id}:${block.name}` : `${index}:${block.type}`;
			let part = this.#parts.get(key);
			if (!part) {
				if (block.type === "thinking") {
					const markdown = new MarkdownView();
					const label = h("span");
					part = { type: "thinking", markdown, label, element: h("details", { class: "thinking" },
						h("summary", null, icon("bulb", 14), label, icon("chevron", 14)), markdown.element,
					) };
				} else if (block.type === "text") {
					const markdown = new MarkdownView();
					part = { type: "text", markdown, element: markdown.element };
				} else {
					const card = new ToolCard(block.name, block.arguments);
					part = { type: "toolCall", card, element: card.element, id: block.id, name: block.name };
				}
			}
			parts.set(key, part);
			if (part.type === "thinking" && block.type === "thinking") {
				hasNonTool = true;
				const thinking = live && last;
				part.element.toggleAttribute("data-live", thinking);
				const label = t(thinking ? "thinking.live" : "thinking.title");
				if (part.label.textContent !== label) part.label.textContent = label;
				const body = part.markdown.element;
				const follow = part.element.open && body.scrollHeight - body.scrollTop - body.clientHeight < 2;
				part.markdown.update(block.thinking, thinking);
				if (follow) body.scrollTop = body.scrollHeight;
				nodes.push(part.element);
			} else if (part.type === "text" && block.type === "text") {
				hasNonTool = true;
				part.markdown.update(block.text, live && last);
				nodes.push(part.element);
			} else if (part.type === "toolCall" && block.type === "toolCall") {
				hasTool = true;
				part.card.setArguments(block.arguments);
				part.card.setStatus(live ? "streaming" : "pending");
				if (!group) {
					group = this.#groups.get(index) ?? h("div", { class: "tools" });
					groups.set(index, group);
					nodes.push(group);
				}
				groupCards.push(part.element);
			}
		}
		flushGroup();
		for (const [key, part] of this.#parts) if (!parts.has(key) && part.type !== "toolCall") part.markdown.dispose();
		this.#parts = parts;
		this.#groups = groups;
		reconcileChildren(this.element, nodes);
		return hasTool && !hasNonTool;
	}

	dispose() {
		for (const part of this.#parts.values()) if (part.type !== "toolCall") part.markdown.dispose();
		this.#parts.clear();
		this.#groups.clear();
	}
}
