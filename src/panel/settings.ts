// Provider credentials and appearance; form state belongs to the sheet, not to the panel's conversation controller.
import type { ProviderSummary, Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { ext } from "../platform/webext.ts";
import { t } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, logo, toast } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>, "providers" | "setApiKey" | "clearApiKey">;
type Theme = "system" | "light" | "dark";
const context = BACKGROUND_CONTEXT;
const THEME_KEY = "oshawatt:theme";
const savedTheme = (): Theme => {
	const value = localStorage.getItem(THEME_KEY);
	return value === "light" || value === "dark" ? value : "system";
};
function applyTheme(theme: Theme) {
	document.documentElement.dataset.theme = theme;
	if (theme === "system") localStorage.removeItem(THEME_KEY);
	else localStorage.setItem(THEME_KEY, theme);
}
export const initializeTheme = () => applyTheme(savedTheme());

const MARKS: Record<string, string> = {
	anthropic: "#c96442", openai: "#10a37f", google: "#3b78e7", openrouter: "#6366f1", deepseek: "#4d6bfe",
};

export class SettingsSheet implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #card = h("div", { class: "card providers", id: "providers" });
	#expanded: string | undefined;
	#closed = false;

	constructor(source: () => Source | undefined, onClose: () => void) {
		this.#source = source;
		const providers = source()?.providers.value ?? [];
		this.#expanded = providers.some((provider) => provider.configured) ? undefined : providers[0]?.id;
		this.element = h(
			"section", { class: "sheet", id: "settings", "aria-label": t("settings.title") },
			h("div", { class: "panel-head" },
				h("button", { class: "icon-btn", id: "settings-back", type: "button", "aria-label": t("settings.title"), onclick: onClose }, icon("back", 18)),
				h("span", { class: "panel-title" }, t("settings.title"))),
			h("div", { class: "sheet-body" },
				h("section", { class: "section" }, h("h3", null, t("settings.providers")), this.#card,
					h("p", { class: "section-hint" }, icon("lock", 12), h("span", null, t("settings.providersHint")))),
				h("section", { class: "section" }, h("h3", null, t("settings.appearance")), this.#themes()),
				h("section", { class: "section" }, h("h3", null, t("settings.about")),
					h("div", { class: "card about" }, logo(34), h("div", null, h("strong", null, "Oshawatt"), h("span", null, t("settings.version", ext.runtime.getManifest().version))))),
			),
		);
	}

	refresh() {
		if (!this.#closed) this.#card.replaceChildren(...(this.#source()?.providers.value ?? []).map((provider) => this.#row(provider)));
	}

	close() {
		this.#closed = true;
	}

	#row(provider: ProviderSummary) {
		const open = this.#expanded === provider.id;
		const input = h("input", {
			class: "input", type: "password", placeholder: t("settings.keyPlaceholder"), autocomplete: "off", spellcheck: "false", "aria-label": `${provider.name} API key`,
		});
		const save = h("button", { class: "btn primary", type: "button" }, provider.configured ? t("settings.replace") : t("settings.save"));
		save.addEventListener("click", async () => {
			if (!input.value.trim()) return input.focus();
			save.disabled = true;
			try {
				const source = this.#source();
				if (!source) throw new Error("The workspace is not ready.");
				await source.setApiKey({ provider: provider.id, key: input.value }, context);
				this.#expanded = undefined;
				this.refresh();
				toast(t("settings.saved"));
			} catch (error) {
				toast(String((error as Error)?.message ?? error), "error");
			} finally {
				save.disabled = false;
			}
		});
		input.addEventListener("keydown", (event) => event.key === "Enter" && save.click());
		const remove = h("button", { class: "btn danger", type: "button" }, t("settings.remove"));
		remove.addEventListener("click", async () => {
			remove.disabled = true;
			try {
				const source = this.#source();
				if (!source) throw new Error("The workspace is not ready.");
				await source.clearApiKey({ provider: provider.id }, context);
				this.refresh();
				toast(t("settings.removed"));
			} catch (error) {
				toast(String((error as Error)?.message ?? error), "error");
			} finally {
				remove.disabled = false;
			}
		});
		return h(
			"div", { class: "provider", "data-provider": provider.id, "data-open": open || null },
			h("button", {
				class: "provider-head", type: "button", "aria-expanded": String(open),
				onclick: () => {
					this.#expanded = open ? undefined : provider.id;
					this.refresh();
					if (!open) this.#card.querySelector<HTMLInputElement>(`[data-provider="${provider.id}"] input`)?.focus();
				},
			},
				h("span", { class: "provider-mark", style: `--mark:${MARKS[provider.id] ?? "var(--accent)"}` }, provider.name.slice(0, 1).toUpperCase()),
				h("span", { class: "provider-name" }, provider.name),
				h("span", { class: "pill", "data-on": provider.configured || null }, provider.configured ? t("settings.connected") : t("settings.notSet")), icon("chevron", 14)),
			open ? h("div", { class: "provider-form" }, input, save, provider.configured ? remove : null) : null,
		);
	}

	#themes() {
		const themes: Theme[] = ["system", "light", "dark"];
		const segmented = h("div", { class: "segmented", role: "radiogroup", "aria-label": t("settings.appearance") }, themes.map((theme) =>
			h("button", {
				type: "button", role: "radio", "data-value": theme, "aria-checked": String(savedTheme() === theme),
				onclick: () => {
					applyTheme(theme);
					for (const button of segmented.querySelectorAll("button")) button.setAttribute("aria-checked", String(button.dataset.value === theme));
				},
			}, t(`settings.theme.${theme}`)),
		));
		return segmented;
	}
}
