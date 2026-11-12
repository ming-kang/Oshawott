import type { ToolDiagnostic } from "@earendil-works/pi-durable";
import { NO_ACCESS_CODE } from "../contracts/browser.ts";
import { formatBytes } from "../lib/bytes.ts";
import { sitePattern } from "../platform/patterns.ts";
import { ext } from "../platform/webext.ts";
import { t } from "./i18n/index.ts";
import { h, type IconName, icon, toast, toastError } from "./ui.ts";

export type ToolStatus = "pending" | "running" | "done" | "error" | "stopped" | "streaming";

type Look = { icon: IconName; label: string; meta?: string };

const clip = (text: string, max: number) => ([...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text);

function hostOf(url: unknown) {
	try {
		return new URL(String(url)).host;
	} catch {
		return String(url ?? "");
	}
}

export function toolLook(name: string, args: Record<string, unknown>): Look {
	switch (name) {
		case "page_snapshot":
			return { icon: "eye", label: t("tool.snapshot"), meta: String(args.ref ?? args.selector ?? "") };
		case "page_inspect":
			return { icon: "code", label: t("tool.inspect"), meta: String(args.ref ?? args.selector ?? "") };
		case "page_click":
			return { icon: "pointer", label: t("tool.click"), meta: String(args.ref ?? "") };
		case "page_type":
			return { icon: "keyboard", label: t("tool.type"), meta: `“${clip(String(args.text ?? ""), 40)}”` };
		case "page_select":
			return { icon: "list", label: t("tool.select"), meta: String(args.option ?? "") };
		case "page_press":
			return { icon: "keyboard", label: t("tool.press"), meta: [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key ?? ""].join("+") };
		case "page_hover":
			return { icon: "pointer", label: t("tool.hover"), meta: String(args.ref ?? "") };
		case "page_wait":
			return { icon: "refresh", label: t("tool.wait"), meta: String(args.selector ?? args.text ?? (args.timeoutMs ? `${args.timeoutMs} ms` : "")) };
		case "page_scroll":
			return { icon: "scroll", label: t("tool.scroll"), meta: args.ref ? String(args.ref) : args.pixels ? `${args.pixels}px` : "" };
		case "tabs_list":
			return { icon: "tabs", label: t("tool.tabs") };
		case "tab_open":
			return { icon: "external", label: t("tool.open"), meta: hostOf(args.url) };
		case "tab_navigate":
			return { icon: args.back ? "back" : "globe", label: t(args.back ? "tool.back" : "tool.navigate"), meta: args.back ? "" : hostOf(args.url) };
		case "tab_activate":
			return { icon: "tabs", label: t("tool.activate"), meta: String(args.tabId ?? "") };
		case "tab_close":
			return { icon: "x", label: t("tool.close"), meta: String(args.tabId ?? "") };
		case "codemode":
			return { icon: "code", label: t("tool.code") };
		case "read":
		case "read_text":
			return { icon: "file", label: t("tool.read"), meta: String(args.path ?? "") };
		case "write":
			return { icon: "file", label: t("tool.write"), meta: String(args.path ?? "") };
		case "edit":
			return { icon: "compose", label: t("tool.edit"), meta: String(args.path ?? "") };
		case "ls":
			return { icon: "folder", label: t("tool.ls"), meta: String(args.path ?? "/workspace") };
		case "fetch":
			return { icon: "download", label: t("tool.fetch"), meta: hostOf(args.url) };
		default:
			return { icon: "tool", label: name };
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function resultMeta(name: string, details: unknown): string | undefined {
	const data = record(details);
	if (name === "fetch") {
		const http = record(data?.http);
		return http && count(http.status) && http.status >= 100 && http.status <= 599 && count(http.bytes)
			? `HTTP ${http.status} · ${formatBytes(http.bytes)}` : undefined;
	}
	if (name === "page_snapshot") {
		const snapshot = record(data?.snapshot);
		if (snapshot && typeof snapshot.title === "string" && count(snapshot.elementCount)) {
			return [snapshot.title, t("tool.elements", snapshot.elementCount)].filter(Boolean).join(" · ");
		}
	}
	if (name === "page_inspect") {
		const inspect = record(data?.inspect);
		if (inspect && count(inspect.matched) && count(inspect.shown)) {
			return inspect.shown < inspect.matched ? t("tool.inspected", inspect.shown, inspect.matched) : t("tool.elements", inspect.matched);
		}
	}
	return undefined;
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
	readonly #initialMeta: string;
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
		const code = name === "codemode" && typeof args.code === "string" ? args.code : undefined;
		if (code !== undefined) this.#body.append(section(t("tool.args"), h("pre", { class: "code" }, code)));
		else if (Object.keys(args).length) this.#body.append(section(t("tool.args"), h("pre", null, pretty(args))));
		this.#summary = h("summary", null, h("span", { class: "tool-icon" }, icon(iconName, 14)), h("span", { class: "tool-label" }, label), this.#meta, this.#state);
		this.element = h("details", { class: "tool", "data-tool": name }, this.#summary, this.#body);
		this.setStatus("pending");
	}

	get settled() {
		return this.#status === "done" || this.#status === "error";
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
		const shown = pretty(text);
		this.#result = section(t("tool.result"), h("pre", { class: isError ? "error" : null }, shown.length > MAX_SHOWN ? `${shown.slice(0, MAX_SHOWN)}\n…` : shown));
		this.#body.append(this.#result);
		const meta = isError ? undefined : resultMeta(this.#name, details);
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

function section(title: string, content: HTMLElement) {
	return h("div", { class: "tool-section" }, h("h4", null, title), content);
}
