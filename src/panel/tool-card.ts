import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import { NO_ACCESS_CODE } from "../contracts/browser.ts";
import { sitePattern } from "../platform/patterns.ts";
import { ext } from "../platform/webext.ts";
import { t } from "./i18n/index.ts";
import { record, resolveToolLook, type ToolLook, toolViewFor } from "./tool-views.ts";
import { h, icon, toast, toastError } from "./ui.ts";

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
	readonly #summary: HTMLElement;
	#initialMeta: string;
	#args: HTMLElement | undefined;
	#argsText: HTMLPreElement | undefined;
	#argsSource: string | undefined;
	readonly #onAllowed: ((site: string) => void) | undefined;
	#grant: HTMLButtonElement | undefined;
	#result: HTMLElement | undefined;
	#output: HTMLElement | undefined;
	#status: ToolStatus = "pending";

	/** `onAllowed`: the user granted the site this call was refused on, so the task can go on. */
	constructor(name: string, args: Record<string, unknown>, onAllowed?: (site: string) => void) {
		this.#name = name;
		this.#onAllowed = onAllowed;
		const { icon: iconName, label, meta } = toolLook(name, args);
		this.#initialMeta = meta ?? "";
		this.#meta = h("span", { class: "tool-meta" }, this.#initialMeta);
		this.#state = h("span", { class: "tool-state", role: "status", "aria-live": "polite" });
		this.#body = h("div", { class: "tool-body" });
		this.setArguments(args);
		this.#summary = h("summary", null, h("span", { class: "tool-icon" }, icon(iconName, 14)), h("span", { class: "tool-label" }, label), this.#meta, this.#state);
		this.element = h("details", { class: "tool", "data-tool": name }, this.#summary, this.#body);
		this.setStatus("pending");
	}

	get settled() {
		return this.#status === "done" || this.#status === "error";
	}

	/** A model may still be streaming the arguments; keep the disclosure and its controls. */
	setArguments(args: Record<string, unknown>) {
		const meta = toolLook(this.#name, args).meta ?? "";
		if (this.#initialMeta !== meta) {
			this.#initialMeta = meta;
			if (!this.settled) this.#meta.textContent = meta;
		}
		const code = this.#name === "codemode" && typeof args.code === "string" ? args.code : undefined;
		const source = code ?? (Object.keys(args).length ? pretty(args) : undefined);
		if (source === this.#argsSource) return;
		this.#argsSource = source;
		if (source === undefined) {
			this.#args?.remove();
			this.#args = this.#argsText = undefined;
			return;
		}
		if (!this.#argsText) {
			this.#argsText = h("pre");
			this.#args = section(t("tool.args"), this.#argsText);
			this.#body.prepend(this.#args);
		}
		this.#argsText.classList.toggle("code", code !== undefined);
		this.#argsText.textContent = source;
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
					? icon("check", 14)
					: status === "error"
						? icon("alert", 14)
						: h("span", { class: "tool-stopped", "aria-hidden": "true" }, title),
			h("span", { class: "sr-only" }, title),
		);
	}

	setOutput(output: string | undefined) {
		if (this.settled || !output) return;
		if (!this.#output) {
			this.#output = h("pre");
			this.#body.append(section(t("tool.output"), this.#output));
		}
		this.#output.textContent = output.slice(-MAX_SHOWN);
	}

	setResult(text: string, isError: boolean, details?: unknown, diagnostics: readonly ToolDiagnostic[] = []) {
		this.#output?.parentElement?.remove();
		this.#output = undefined;
		this.#result?.remove();
		const view = toolViewFor(this.#name);
		const rich = isError ? undefined : view?.body?.({ text, isError, details });
		const shown = pretty(text);
		const content = rich ?? h("pre", { class: isError ? "error" : null }, shown.length > MAX_SHOWN ? `${shown.slice(0, MAX_SHOWN)}\n…` : shown);
		this.#result = section(t("tool.result"), content);
		this.#body.append(this.#result);
		const meta = isError ? undefined : view?.resultMeta?.(details);
		this.#meta.textContent = meta ?? this.#initialMeta;
		this.setStatus(isError ? "error" : "done");
		this.#grant?.remove();
		this.#grant = undefined;
		delete this.element.dataset.needsAccess;
		const access = record(record(details)?.access);
		if (isError && diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.code === NO_ACCESS_CODE) && typeof access?.url === "string") {
			this.#offerAccess(access.url);
		}
	}

	#offerAccess(url: string) {
		const pattern = sitePattern(url);
		if (!pattern) return;
		const button = h("button", { class: "grant-btn tool-grant", type: "button" }, icon("lock", 12), t("tab.grant"));
		button.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			button.disabled = true;
			try {
				// No await before request: Firefox must see it in the click's user gesture.
				const allowed = await ext.permissions.request({ origins: [pattern] });
				if (allowed) {
					button.replaceChildren(icon("check", 12), t("tool.allowed"));
					if (this.#onAllowed) this.#onAllowed(new URL(url).host);
					else toast(t("tool.retryHint"));
				} else {
					button.disabled = false;
					toast(t("tab.denied"), "error");
				}
			} catch (error) {
				button.disabled = false;
				toastError(error);
			}
		});
		this.#grant = button;
		this.element.dataset.needsAccess = "";
		this.#summary.insertBefore(button, this.#state);
	}
}

function section(title: string, content: Node) {
	return h("div", { class: "tool-section" }, h("h4", null, title), content);
}
