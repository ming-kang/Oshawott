import { DEFAULT_BUSY_MODE, type BusyMode, type ProviderSummary, type Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { ext } from "../platform/webext.ts";
import { t } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, logo, toast } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"providers" | "setApiKey" | "clearApiKey" | "busyMode" | "setBusyMode"
>;
type Theme = "system" | "light" | "dark";
const context = BACKGROUND_CONTEXT;
const THEME_KEY = "oshawott:theme";
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
	readonly #delivery = h("div", { class: "segmented", id: "settings-delivery", role: "radiogroup", "aria-label": t("settings.messaging") });
	#expanded: string | undefined;
	#closed = false;
	#deliveryPending = false;

	constructor(source: () => Source | undefined, onClose: () => void) {
		this.#source = source;
		const providers = source()?.providers.value ?? [];
		this.#expanded = providers.some((provider) => provider.configured) ? undefined : providers[0]?.id;
		this.#buildDelivery();
		this.element = h(
			"section", { class: "sheet", id: "settings", role: "dialog", "aria-modal": "true", "aria-label": t("settings.title") },
			h("div", { class: "panel-head" },
				h("button", { class: "icon-btn", id: "settings-back", type: "button", "aria-label": t("settings.back"), onclick: onClose }, icon("back", 18)),
				h("span", { class: "panel-title" }, t("settings.title"))),
			h("div", { class: "sheet-body" },
				h("section", { class: "section" }, h("h3", null, t("settings.providers")), this.#card,
					h("p", { class: "section-hint" }, icon("lock", 12), h("span", null, t("settings.providersHint")))),
				h("section", { class: "section" }, h("h3", null, t("settings.messaging")), this.#delivery,
					h("p", { class: "section-hint" }, h("span", null, t("settings.messagingHint")))),
				h("section", { class: "section" }, h("h3", null, t("settings.appearance")), this.#themes()),
				h("section", { class: "section" }, h("h3", null, t("settings.about")),
					h("div", { class: "card about" }, logo(34), h("div", null, h("strong", null, "Oshawott"), h("span", null, t("settings.version", ext.runtime.getManifest().version))))),
			),
		);
	}

	refresh() {
		if (this.#closed) return;
		this.#refreshDelivery();
		const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const providerId = active?.closest<HTMLElement>(".provider")?.dataset.provider;
		const action = active?.classList.contains("provider-head") ? ".provider-head"
			: active?.classList.contains("danger") ? ".btn.danger"
				: active?.classList.contains("primary") ? ".btn.primary"
					: active?.tagName === "INPUT" ? "input" : undefined;
		this.#card.replaceChildren(...(this.#source()?.providers.value ?? []).map((provider) => this.#row(provider)));
		if (providerId && action) {
			const provider = this.#card.querySelector<HTMLElement>(`[data-provider="${providerId}"]`);
			(provider?.querySelector<HTMLElement>(action) ?? provider?.querySelector<HTMLElement>(".provider-head"))?.focus({ preventScroll: true });
		}
	}

	close() {
		this.#closed = true;
	}

	#row(provider: ProviderSummary) {
		const open = this.#expanded === provider.id;
		const input = h("input", {
			class: "input", type: "password", placeholder: t("settings.keyPlaceholder"), autocomplete: "off", spellcheck: "false", "aria-label": `${provider.name} API key`,
		});
		const saveLabel = provider.configured ? t("settings.replace") : t("settings.save");
		const save = h("button", { class: "btn primary", type: "button", "aria-label": `${provider.name}: ${saveLabel}` }, saveLabel);
		save.addEventListener("click", async () => {
			if (!input.value.trim()) return input.focus();
			save.disabled = true;
			save.setAttribute("aria-busy", "true");
			save.prepend(h("span", { class: "spinner" }));
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
				save.removeAttribute("aria-busy");
				save.querySelector(".spinner")?.remove();
			}
		});
		input.addEventListener("keydown", (event) => event.key === "Enter" && save.click());
		const remove = h("button", { class: "btn danger", type: "button", "aria-label": `${provider.name}: ${t("settings.remove")}` }, t("settings.remove"));
		remove.addEventListener("click", async () => {
			remove.disabled = true;
			remove.setAttribute("aria-busy", "true");
			remove.prepend(h("span", { class: "spinner" }));
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
				remove.removeAttribute("aria-busy");
				remove.querySelector(".spinner")?.remove();
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
				h("span", { class: "provider-mark", "aria-hidden": "true", style: `--mark:${MARKS[provider.id] ?? "var(--accent)"}` }, provider.name.slice(0, 1).toUpperCase()),
				h("span", { class: "provider-name" }, provider.name),
				h("span", { class: "pill", "data-on": provider.configured || null }, provider.configured ? t("settings.connected") : t("settings.notSet")), icon("chevron", 14)),
			open ? h("div", { class: "provider-form" }, input, save, provider.configured ? remove : null) : null,
		);
	}

	#buildDelivery() {
		const modes: BusyMode[] = ["steer", "followUp"];
		for (const [index, mode] of modes.entries()) {
			this.#delivery.append(h("button", {
				type: "button", role: "radio", "data-value": mode,
				onclick: () => void this.#chooseDelivery(mode),
				onkeydown: (event: KeyboardEvent) => {
					const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % modes.length
						: event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + modes.length - 1) % modes.length
							: event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : -1;
					if (next < 0) return;
					event.preventDefault();
					void this.#chooseDelivery(modes[next]!, true);
				},
			}, t(mode === "steer" ? "queue.steer" : "queue.followUp")));
		}
		this.#refreshDelivery();
	}

	async #chooseDelivery(mode: BusyMode, focus = false) {
		if (this.#deliveryPending) return;
		const source = this.#source();
		if (!source) return toast(t("reconnecting"), "error");
		if (source.busyMode.value === mode) {
			if (focus) this.#delivery.querySelector<HTMLButtonElement>(`[data-value="${mode}"]`)?.focus({ preventScroll: true });
			return;
		}
		this.#deliveryPending = true;
		this.#refreshDelivery();
		try {
			await source.setBusyMode(mode, context);
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#deliveryPending = false;
			this.#refreshDelivery();
			if (focus) {
				const selected = this.#source()?.busyMode.value ?? mode;
				this.#delivery.querySelector<HTMLButtonElement>(`[data-value="${selected}"]`)?.focus({ preventScroll: true });
			}
		}
	}

	#refreshDelivery() {
		const selected = this.#source()?.busyMode.value ?? DEFAULT_BUSY_MODE;
		for (const button of this.#delivery.querySelectorAll<HTMLButtonElement>("button")) {
			const active = button.dataset.value === selected;
			button.setAttribute("aria-checked", String(active));
			button.tabIndex = active ? 0 : -1;
			button.disabled = this.#deliveryPending;
		}
	}

	#themes() {
		const themes: Theme[] = ["system", "light", "dark"];
		const segmented = h("div", { class: "segmented", role: "radiogroup", "aria-label": t("settings.appearance") });
		const choose = (theme: Theme, focus = false) => {
			applyTheme(theme);
			for (const button of segmented.querySelectorAll<HTMLButtonElement>("button")) {
				const selected = button.dataset.value === theme;
				button.setAttribute("aria-checked", String(selected));
				button.tabIndex = selected ? 0 : -1;
				if (selected && focus) button.focus({ preventScroll: true });
			}
		};
		for (const theme of themes) {
			const button = h("button", {
				type: "button", role: "radio", "data-value": theme, "aria-checked": String(savedTheme() === theme),
				tabindex: savedTheme() === theme ? 0 : -1,
				onclick: () => choose(theme),
				onkeydown: (event: KeyboardEvent) => {
					const at = themes.indexOf(theme);
					const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (at + 1) % themes.length
						: event.key === "ArrowLeft" || event.key === "ArrowUp" ? (at + themes.length - 1) % themes.length
							: event.key === "Home" ? 0 : event.key === "End" ? themes.length - 1 : -1;
					if (next < 0) return;
					event.preventDefault();
					choose(themes[next]!, true);
				},
			}, t(`settings.theme.${theme}`));
			segmented.append(button);
		}
		return segmented;
	}
}
