import { DEFAULT_BUSY_MODE, type BusyMode, type ProviderSummary, type Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { ext } from "../platform/webext.ts";
import { saveLanguage, savedLanguagePreference, t, type LanguagePreference } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, logo, toast } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"providers" | "busyMode" | "setBusyMode"
	| "autoTitle" | "autoCompaction" | "autoRetry" | "setAutoTitle" | "setAutoCompaction" | "setAutoRetry"
	| "instructions" | "setInstructions" | "resetInstructions"
>;
type Preference = "autoTitle" | "autoCompaction" | "autoRetry";
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

export class SettingsSheet implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #card = h("div", { class: "card providers", id: "providers" });
	readonly #delivery = h("div", { class: "segmented", id: "settings-delivery", role: "radiogroup", "aria-label": t("settings.messaging") });
	readonly #onEditProvider: (id?: string) => void;
	readonly #preferences: { key: Preference; input: HTMLInputElement }[] = [];
	readonly #instructions = h("textarea", {
		class: "instructions-input", id: "settings-instructions", rows: 9, spellcheck: "false",
		"aria-labelledby": "settings-instructions-label", "aria-describedby": "settings-instructions-hint settings-instructions-status",
	});
	readonly #instructionsSave = h("button", { class: "btn primary small", id: "instructions-save", type: "button" }, t("settings.instructionsSave"));
	readonly #instructionsRestore = h("button", { class: "btn small", id: "instructions-restore", type: "button" }, t("settings.instructionsRestore"));
	readonly #instructionsLoadLatest = h("button", { class: "btn small", id: "instructions-load-latest", type: "button" }, t("settings.instructionsLoadLatest"));
	readonly #instructionsStatusText = h("span");
	readonly #instructionsStatus = h("div", { class: "instructions-status", id: "settings-instructions-status", role: "status", hidden: true }, this.#instructionsStatusText, this.#instructionsLoadLatest);
	#closed = false;
	#deliveryPending = false;
	#preferencePending = false;
	#instructionsPending = false;
	#instructionsDirty = false;
	#instructionsBaseline = "";
	/** The stored text a finished Save/Restore returned, until this panel observes it. */
	#instructionsAwaitingSync: string | undefined;
	#instructionsRestoreConfirm = false;
	#instructionsRestoreTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(source: () => Source | undefined, onClose: () => void, onEditProvider: (id?: string) => void) {
		this.#source = source;
		this.#onEditProvider = onEditProvider;
		this.#buildDelivery();
		this.#instructions.addEventListener("input", () => {
			if (this.#instructionsAwaitingSync !== undefined) this.#instructionsBaseline = this.#instructionsAwaitingSync;
			this.#instructionsAwaitingSync = undefined;
			this.#instructionsDirty = true;
			this.#refreshInstructions();
		});
		this.#instructionsSave.addEventListener("click", () => void this.#mutateInstructions(this.#instructions.value));
		this.#instructionsRestore.addEventListener("click", () => this.#restoreInstructions());
		this.#instructionsLoadLatest.addEventListener("click", () => {
			if (this.#instructionsPending || !this.#source()) return;
			this.#instructionsAwaitingSync = undefined;
			this.#instructionsDirty = false;
			this.#clearRestoreConfirmation();
			this.#refreshInstructions();
			this.#instructions.focus({ preventScroll: true });
		});
		this.element = h(
			"section", { class: "sheet", id: "settings", role: "dialog", "aria-modal": "true", "aria-label": t("settings.title") },
			h("div", { class: "panel-head" },
				h("button", { class: "icon-btn", id: "settings-back", type: "button", "aria-label": t("settings.back"), onclick: onClose }, icon("back", 18)),
				h("span", { class: "panel-title" }, t("settings.title"))),
			h("div", { class: "sheet-body" },
				h("section", { class: "section" },
					h("div", { class: "section-heading" }, h("h3", null, t("settings.providers")),
						h("button", { class: "btn small", id: "add-provider", type: "button", onclick: () => this.#onEditProvider() }, icon("plus", 14), t("settings.addProvider"))),
					this.#card,
					h("p", { class: "section-hint" }, icon("lock", 12), h("span", null, t("settings.providersHint")))),
				h("section", { class: "section" }, h("h3", { id: "settings-instructions-label" }, t("settings.instructions")),
					this.#instructions,
					h("div", { class: "provider-section-action" }, this.#instructionsSave, this.#instructionsRestore),
					this.#instructionsStatus,
					h("p", { class: "section-hint", id: "settings-instructions-hint" }, h("span", null, t("settings.instructionsHint")))),
				h("section", { class: "section" }, h("h3", null, t("settings.conversation")),
					this.#preference("autoTitle", t("settings.autoTitle")),
					h("p", { class: "section-hint" }, h("span", null, t("settings.autoTitleHint"))),
					this.#preference("autoCompaction", t("settings.autoCompaction")),
					h("p", { class: "section-hint" }, h("span", null, t("settings.autoCompactionHint"))),
					this.#preference("autoRetry", t("settings.autoRetry")),
					h("p", { class: "section-hint" }, h("span", null, t("settings.autoRetryHint")))),
				h("section", { class: "section" }, h("h3", null, t("settings.messaging")), this.#delivery,
					h("p", { class: "section-hint" }, h("span", null, t("settings.messagingHint")))),
				h("section", { class: "section" }, h("h3", null, t("settings.appearance")), this.#themes()),
				h("section", { class: "section" }, h("h3", null, t("settings.language")), this.#languages(),
					h("p", { class: "section-hint" }, h("span", null, t("settings.languageHint")))),
				h("section", { class: "section" }, h("h3", null, t("settings.about")),
					h("div", { class: "card about" }, logo(34), h("div", null, h("strong", null, "Oshawott"), h("span", null, t("settings.version", ext.runtime.getManifest().version))))),
			),
		);
	}

	refresh() {
		if (this.#closed) return;
		this.#refreshDelivery();
		this.#refreshPreferences();
		this.#refreshInstructions();
		const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const providerId = active?.closest<HTMLElement>(".provider")?.dataset.provider;
		const providers = (this.#source()?.providers.value ?? []).filter((provider) => provider.kind === "custom" || provider.configured);
		this.#card.replaceChildren(...(providers.length
			? providers.map((provider) => this.#row(provider))
			: [h("div", { class: "list-empty", id: "providers-empty" }, t("settings.noProviders"))]));
		if (providerId) this.#card.querySelector<HTMLElement>(`[data-provider="${providerId}"] .provider-head`)?.focus({ preventScroll: true });
	}

	close() {
		this.#closed = true;
		this.#clearRestoreConfirmation();
	}

	#row(provider: ProviderSummary) {
		const status = provider.configured ? t("settings.configured") : t("settings.notConfigured");
		return h("div", { class: "provider", "data-provider": provider.id },
			h("button", {
				class: "provider-head", type: "button", "aria-haspopup": "dialog", "aria-label": `${provider.name}: ${status}`,
				onclick: () => this.#onEditProvider(provider.id),
			},
			h("span", { class: "provider-name" }, provider.name),
			h("span", { class: "pill", "data-on": provider.configured || null }, status), icon("chevron", 14)),
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

	#preference(key: Preference, label: string) {
		const input = h("input", { type: "checkbox", id: `settings-${key}` });
		input.addEventListener("change", () => void this.#choosePreference(key, input.checked));
		this.#preferences.push({ key, input });
		return h("label", { class: "setting-row" }, h("span", null, label), input);
	}

	async #choosePreference(key: Preference, enabled: boolean) {
		if (this.#preferencePending) return;
		const source = this.#source();
		if (!source) return toast(t("reconnecting"), "error");
		this.#preferencePending = true;
		this.#refreshPreferences();
		try {
			if (key === "autoTitle") await source.setAutoTitle(enabled, context);
			else if (key === "autoCompaction") await source.setAutoCompaction(enabled, context);
			else await source.setAutoRetry(enabled, context);
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#preferencePending = false;
			this.#refreshPreferences();
		}
	}

	#refreshPreferences() {
		const source = this.#source();
		for (const { key, input } of this.#preferences) {
			input.checked = source?.[key].value ?? (key !== "autoTitle");
			input.disabled = this.#preferencePending || !source;
		}
	}

	#refreshInstructions() {
		if (this.#closed) return;
		const source = this.#source();
		const value = source?.instructions.value;
		if (value !== undefined && !this.#instructionsPending) {
			// The RPC can return before its publication reaches this panel; keep the draft until the stored text arrives.
			if (this.#instructionsAwaitingSync !== undefined && value === this.#instructionsAwaitingSync) {
				this.#instructionsAwaitingSync = undefined;
				this.#instructionsDirty = false;
			}
			if (!this.#instructionsDirty) {
				if (this.#instructions.value !== value) this.#instructions.value = value;
				this.#instructionsBaseline = value;
			}
		}
		const waiting = this.#instructionsAwaitingSync !== undefined;
		const conflict = value !== undefined && this.#instructionsDirty && !waiting && value !== this.#instructionsBaseline;
		const message = t(conflict ? "settings.instructionsChangedElsewhere" : "settings.instructionsWaitingForSync");
		if (this.#instructionsStatusText.textContent !== message) this.#instructionsStatusText.textContent = message;
		this.#instructionsStatus.hidden = this.#instructionsPending || !(conflict || waiting);
		this.#instructions.disabled = this.#instructionsSave.disabled = this.#instructionsRestore.disabled = this.#instructionsLoadLatest.disabled = this.#instructionsPending || !source;
	}

	/** Save and Restore share one lifecycle; the Engine returns the text it stored, so normalization is never guessed. */
	async #mutateInstructions(instructions?: string) {
		if (this.#instructionsPending || this.#closed) return;
		this.#clearRestoreConfirmation();
		const source = this.#source();
		if (!source) return toast(t("reconnecting"), "error");
		this.#instructionsPending = true;
		this.#instructionsDirty = true;
		this.#instructionsAwaitingSync = undefined;
		this.#refreshInstructions();
		try {
			this.#instructionsAwaitingSync = instructions === undefined
				? await source.resetInstructions(context)
				: await source.setInstructions({ instructions }, context);
			toast(t(instructions === undefined ? "settings.instructionsRestored" : "settings.instructionsSaved"));
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#instructionsPending = false;
			this.#clearRestoreConfirmation();
			this.#refreshInstructions();
		}
	}

	#clearRestoreConfirmation() {
		clearTimeout(this.#instructionsRestoreTimer);
		this.#instructionsRestoreTimer = undefined;
		if (!this.#instructionsRestoreConfirm) return;
		this.#instructionsRestoreConfirm = false;
		delete this.#instructionsRestore.dataset.confirm;
		this.#instructionsRestore.replaceChildren(t("settings.instructionsRestore"));
	}

	#restoreInstructions() {
		if (this.#instructionsPending || this.#closed) return;
		if (!this.#instructionsRestoreConfirm) {
			this.#instructionsRestoreConfirm = true;
			this.#instructionsRestore.dataset.confirm = "";
			this.#instructionsRestore.replaceChildren(t("settings.instructionsRestoreConfirm"));
			this.#instructionsRestoreTimer = setTimeout(() => this.#clearRestoreConfirmation(), 3000);
			return;
		}
		void this.#mutateInstructions();
	}

	#languages() {
		const languages: { value: LanguagePreference; label: string }[] = [
			{ value: "system", label: t("settings.theme.system") },
			{ value: "zh-CN", label: "中文" },
			{ value: "en", label: "English" },
		];
		const preference = savedLanguagePreference();
		const segmented = h("div", { class: "segmented", id: "settings-language", role: "radiogroup", "aria-label": t("settings.language") });
		const choose = (language: LanguagePreference, focus = false) => {
			for (const button of segmented.querySelectorAll<HTMLButtonElement>("button")) {
				const selected = button.dataset.value === language;
				button.setAttribute("aria-checked", String(selected));
				button.tabIndex = selected ? 0 : -1;
				if (selected && focus) button.focus({ preventScroll: true });
			}
			if (language === savedLanguagePreference()) return;
			saveLanguage(language);
			location.reload();
		};
		for (const [index, language] of languages.entries()) {
			segmented.append(h("button", {
				type: "button", role: "radio", "data-value": language.value, "aria-checked": String(preference === language.value),
				tabindex: preference === language.value ? 0 : -1,
				onclick: () => choose(language.value),
				onkeydown: (event: KeyboardEvent) => {
					const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % languages.length
						: event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + languages.length - 1) % languages.length
							: event.key === "Home" ? 0 : event.key === "End" ? languages.length - 1 : -1;
					if (next < 0) return;
					event.preventDefault();
					choose(languages[next]!.value, true);
				},
			}, language.label));
		}
		return segmented;
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
