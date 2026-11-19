import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import { t } from "./i18n/index.ts";
import { codeBlock } from "./tool-highlight.ts";
import { parseCodemodeResult, resolveToolLook, type ToolBodyView, type ToolLook, type ToolResult, toolViewFor } from "./tool-views.ts";
import { copyButton, h, icon } from "./ui.ts";

export type ToolStatus = "pending" | "running" | "done" | "error" | "stopped" | "streaming";

export function toolLook(name: string, args: Record<string, unknown>): ToolLook {
	return resolveToolLook(name, args);
}

function pretty(value: unknown): string {
	if (typeof value === "string") {
		try {
			return JSON.stringify(JSON.parse(value), null, 2);
		} catch {
			return value;
		}
	}
	return JSON.stringify(value, null, 2);
}

const MAX_SHOWN = 12_000;

export class ToolCard {
	readonly element: HTMLDetailsElement;
	readonly #name: string;
	readonly #meta: HTMLElement;
	readonly #state: HTMLElement;
	readonly #body: HTMLElement;
	readonly #panel: HTMLElement;
	readonly #summary: HTMLElement;
	#args: Record<string, unknown>;
	#initialMeta: string;
	#argsSignature = "";
	#outputText: string | undefined;
	#result: ToolResult | undefined;
	#bodyView: ToolBodyView | undefined;
	#raw = false;
	#errorLine: HTMLElement | undefined;
	#status: ToolStatus = "pending";

	constructor(name: string, args: Record<string, unknown>) {
		this.#name = name;
		this.#args = args;
		const { icon: iconName, label, meta } = toolLook(name, args);
		this.#initialMeta = meta ?? "";
		this.#meta = h("span", { class: "tool-meta" }, this.#initialMeta);
		this.#state = h("span", { class: "tool-state", role: "status", "aria-live": "polite" });
		this.#panel = h("div", { class: "tool-panel" });
		this.#body = h("div", { class: "tool-body" }, this.#panel);
		this.#summary = h("summary", null,
			h("span", { class: "tool-icon" }, icon(iconName, 14)),
			h("span", { class: "tool-label" }, label),
			this.#meta,
			this.#state,
			h("span", { class: "tool-chevron", "aria-hidden": "true" }, icon("chevron", 12)),
		);
		this.element = h("details", { class: "tool", "data-tool": name }, this.#summary, this.#body);
		this.setArguments(args);
		this.setStatus("pending");
	}

	get settled() {
		return this.#status === "done" || this.#status === "error";
	}

	/** A model may still be streaming the arguments; keep the disclosure and its controls. */
	setArguments(args: Record<string, unknown>) {
		this.#args = args;
		const meta = toolLook(this.#name, args).meta ?? "";
		if (this.#initialMeta !== meta) {
			this.#initialMeta = meta;
			if (!this.settled) this.#meta.textContent = meta;
		}
		const signature = JSON.stringify(args);
		if (signature === this.#argsSignature) return;
		this.#argsSignature = signature;
		if (!this.#result) this.#renderPanel();
	}

	setStatus(status: ToolStatus) {
		if (this.settled && status !== "done" && status !== "error") return;
		if (this.#status === status && this.#state.childNodes.length) return;
		this.#status = status;
		this.element.dataset.status = status;
		const title = {
			pending: t("tool.pending"), streaming: t("tool.pending"), running: t("tool.running"), stopped: t("tool.stopped"),
			done: t("tool.done"), error: t("tool.error"),
		}[status];
		this.#state.title = title;
		this.#state.replaceChildren(
			status === "running" || status === "pending" || status === "streaming"
				? h("span", { class: "spinner", "aria-hidden": "true" })
				: status === "done"
					? icon("check", 13)
					: status === "error"
						? icon("alert", 13)
						: h("span", { class: "tool-stopped", "aria-hidden": "true" }, title),
			h("span", { class: "sr-only" }, title),
		);
	}

	setOutput(output: string | undefined) {
		if (this.settled || output === this.#outputText) return;
		this.#outputText = output;
		this.#renderPanel();
	}

	setResult(text: string, isError: boolean, details?: unknown, diagnostics: readonly ToolDiagnostic[] = []) {
		this.#outputText = undefined;
		this.#errorLine?.remove();
		this.#errorLine = undefined;
		this.#result = { text, isError, details, diagnostics };
		this.#raw = false;
		const view = toolViewFor(this.#name);
		this.#renderPanel();
		if (isError) {
			const codemode = this.#name === "codemode" ? parseCodemodeResult(text) : undefined;
			const sourceText = codemode && !codemode.ok && codemode.output.trim() ? codemode.output : text;
			const line = diagnostics.find((diagnostic) => diagnostic.severity === "error")?.message
				?? sourceText.split("\n")
					.map((part) => part.trim())
					.filter((part) => part && !/^<\/?harness>$/.test(part) && !/^Script error:?$/i.test(part))
					.map((part) => part.replace(/^\[(?:error|warning)\]\s*/i, ""))
					.find(Boolean) ?? "";
			if (line) {
				this.#errorLine = h("div", { class: "tool-error" }, line);
				this.#summary.append(this.#errorLine);
			}
		}
		const meta = isError ? undefined : view?.resultMeta?.(details, this.#initialMeta, this.#result);
		this.#meta.textContent = meta ?? this.#initialMeta;
		this.setStatus(isError ? "error" : "done");
	}

	#rawContent(): { node: Node; copy: string } {
		const blocks: Node[] = [];
		const hasArgs = Object.keys(this.#args).length > 0;
		const hasOutcome = Boolean(this.#result || this.#outputText);
		const code = this.#name === "codemode" && typeof this.#args.code === "string" ? this.#args.code : undefined;
		const argsSource = code ?? (hasArgs ? pretty(this.#args) : undefined);
		if (argsSource !== undefined) {
			const clamped = argsSource.length > MAX_SHOWN ? `${argsSource.slice(0, MAX_SHOWN)}\n…` : argsSource;
			if (hasOutcome) blocks.push(h("div", { class: "tool-raw-label" }, t("tool.args")));
			blocks.push(codeBlock(clamped, code ? "javascript" : "json", code ? "tool-code code" : "tool-code"));
		}
		if (this.#result) {
			const { text, isError } = this.#result;
			const shown = pretty(text);
			const clamped = shown.length > MAX_SHOWN ? `${shown.slice(0, MAX_SHOWN)}\n…` : shown;
			if (blocks.length) {
				blocks.push(h("div", { class: "tool-divider" }));
				blocks.push(h("div", { class: "tool-raw-label" }, t("tool.result")));
			}
			blocks.push(
				codeBlock(clamped, isError ? undefined : (shown !== text ? "json" : undefined), isError ? "tool-raw-pre error" : "tool-raw-pre"),
			);
			return { node: h("div", { class: "tv-stack" }, ...blocks), copy: text };
		}
		if (this.#outputText) {
			if (blocks.length) {
				blocks.push(h("div", { class: "tool-divider" }));
				blocks.push(h("div", { class: "tool-raw-label" }, t("tool.output")));
			}
			blocks.push(h("pre", { class: "tool-raw-pre" }, this.#outputText.slice(-MAX_SHOWN)));
		}
		const copy = this.#outputText ?? argsSource ?? "";
		return {
			node: blocks.length ? h("div", { class: "tv-stack" }, ...blocks) : h("div", { class: "tool-empty" }, t("tool.pending")),
			copy,
		};
	}

	#renderPanel() {
		const view = toolViewFor(this.#name);
		this.#bodyView = view?.body?.(this.#args, this.#result);
		const rich = this.#bodyView;
		const canToggleRaw = Boolean(rich);
		const useRaw = this.#raw || !rich;
		const raw = useRaw ? this.#rawContent() : undefined;
		let bodyNode: Node = useRaw ? raw!.node : rich!.content;
		if (!useRaw && !this.#result && this.#outputText) {
			bodyNode = h("div", { class: "tv-stack" },
				rich!.content,
				h("div", { class: "tool-divider" }),
				h("pre", { class: "tool-raw-pre" }, this.#outputText.slice(-MAX_SHOWN)),
			);
		}
		const copySource = () => (this.#raw || !this.#bodyView ? (this.#result?.text ?? this.#outputText ?? pretty(this.#args)) : (this.#bodyView.copyText ?? this.#result?.text ?? ""));
		const labelText = useRaw ? (this.#result ? t("tool.result") : t("tool.args")) : (rich?.label ?? "");
		const actions: Node[] = [];
		if (canToggleRaw) {
			const toggle = h("button", { class: "tool-toggle", type: "button", "aria-pressed": String(this.#raw) }, t("tool.raw"));
			toggle.addEventListener("click", () => {
				this.#raw = !this.#raw;
				this.#renderPanel();
			});
			actions.push(toggle);
		}
		actions.push(copyButton(copySource, t("copy")));
		if (labelText) {
			delete this.#panel.dataset.headless;
			this.#panel.replaceChildren(
				h("div", { class: "tool-panel-head" },
					h("span", { class: "tool-panel-label" }, labelText),
					h("div", { class: "tool-panel-actions" }, ...actions),
				),
				h("div", { class: "tool-panel-content" }, bodyNode),
			);
		} else {
			this.#panel.dataset.headless = "true";
			this.#panel.replaceChildren(
				h("div", { class: "tool-panel-content" }, bodyNode),
				h("div", { class: "tool-panel-actions" }, ...actions),
			);
		}
	}
}
