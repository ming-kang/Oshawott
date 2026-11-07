// One tool call as a timeline row: what the tool does in words, its state, and, expanded, its arguments and result.
// A card is made from the call in the assistant's answer, then follows the call: `pi.live` while it runs, its result
// entry when it settles.
import { NO_ACCESS } from "../contracts/browser.ts";
import { formatBytes } from "../lib/bytes.ts";
import { sitePattern } from "../platform/patterns.ts";
import { ext } from "../platform/webext.ts";
import { t } from "./i18n.ts";
import { h, type IconName, icon, toast } from "./ui.ts";

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

function look(name: string, args: Record<string, unknown>): Look {
	switch (name) {
		case "page_snapshot":
			return { icon: "eye", label: t("tool.snapshot") };
		case "page_click":
			return { icon: "pointer", label: t("tool.click"), meta: String(args.ref ?? "") };
		case "page_type":
			return { icon: "keyboard", label: t("tool.type"), meta: `“${clip(String(args.text ?? ""), 40)}”` };
		case "page_scroll":
			return { icon: "scroll", label: t("tool.scroll"), meta: args.ref ? String(args.ref) : args.pixels ? `${args.pixels}px` : "" };
		case "tabs_list":
			return { icon: "tabs", label: t("tool.tabs") };
		case "tab_open":
			return { icon: "external", label: t("tool.open"), meta: hostOf(args.url) };
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

/** A short line about a result, shown next to the label once the call is done. */
function resultMeta(name: string, text: string): string | undefined {
	if (name === "fetch") {
		const summary = /^HTTP (\d{3})[^\n]*? · (\d+) bytes(?: · from .*?)?$/m.exec(text);
		return summary ? `HTTP ${summary[1]} · ${formatBytes(Number(summary[2]))}` : undefined;
	}
	if (name !== "page_snapshot") return undefined;
	try {
		const snapshot = JSON.parse(text) as { title?: string; elements?: unknown[] };
		return [snapshot.title, t("tool.elements", snapshot.elements?.length ?? 0)].filter(Boolean).join(" · ");
	} catch {
		return undefined;
	}
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
	readonly #fetchUrl: string | undefined;
	#grant: HTMLButtonElement | undefined;
	#result: HTMLElement | undefined;
	#output: HTMLElement | undefined;
	#status: ToolStatus = "pending";

	constructor(name: string, args: Record<string, unknown>) {
		this.#name = name;
		this.#fetchUrl = name === "fetch" && typeof args.url === "string" ? args.url : undefined;
		const { icon: iconName, label, meta } = look(name, args);
		this.#meta = h("span", { class: "tool-meta" }, meta ?? "");
		this.#state = h("span", { class: "tool-state" });
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
		this.#status = status;
		this.element.dataset.status = status;
		const title = { pending: t("tool.pending"), streaming: t("tool.pending"), running: t("tool.running"), stopped: t("tool.stopped"), done: "", error: "" }[status];
		this.#state.title = title;
		this.#state.replaceChildren(
			status === "running" || status === "pending" || status === "streaming"
				? h("span", { class: "spinner" })
				: status === "done"
					? icon("check", 14)
					: status === "error"
						? icon("alert", 14)
						: h("span", { class: "tool-stopped" }, title),
		);
	}

	/** Running output from `pi.live` (bounded there). */
	setOutput(output: string | undefined) {
		if (this.settled || !output) return;
		if (!this.#output) {
			this.#output = h("pre");
			this.#body.append(section(t("tool.output"), this.#output));
		}
		this.#output.textContent = output.slice(-MAX_SHOWN);
	}

	setResult(text: string, isError: boolean) {
		this.#output?.parentElement?.remove();
		this.#output = undefined;
		this.#result?.remove();
		const shown = pretty(text);
		this.#result = section(t("tool.result"), h("pre", { class: isError ? "error" : null }, shown.length > MAX_SHOWN ? `${shown.slice(0, MAX_SHOWN)}\n…` : shown));
		this.#body.append(this.#result);
		const meta = isError ? undefined : resultMeta(this.#name, text);
		if (meta) this.#meta.textContent = meta;
		this.setStatus(isError ? "error" : "done");
		this.#grant?.remove();
		this.#grant = undefined;
		delete this.element.dataset.needsAccess;
		if (isError && text.includes(NO_ACCESS)) this.#offerAccess();
	}

	#offerAccess() {
		const pattern = this.#fetchUrl && sitePattern(this.#fetchUrl);
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
					button.title = t("tool.retryHint");
					toast(t("tool.retryHint"));
				} else {
					button.disabled = false;
					toast(t("tab.denied"), "error");
				}
			} catch (error) {
				button.disabled = false;
				toast(String((error as Error)?.message ?? error), "error");
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
