import { DEFAULT_BUSY_MODE, type BusyMode, PREFERENCE_DEFAULTS, type Preference, type ProviderSummary, type Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { ext } from "../platform/webext.ts";
import { saveLanguage, savedLanguagePreference, t, type LanguagePreference } from "./i18n/index.ts";
import type { OverlayView } from "./overlays.ts";
import { segmented } from "./segmented.ts";
import { confirmControl, type ConfirmControl, h, icon, logo, toast, toastError } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"providers" | "busyMode" | "setBusyMode"
	| Preference | "setPreference"
	| "instructions" | "setInstructions" | "resetInstructions"
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

export class SettingsSheet implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #card = h("div", { class: "card providers", id: "providers" });
	readonly #delivery = segmented<BusyMode>({
		id: "settings-delivery", label: t("settings.messaging"), selected: DEFAULT_BUSY_MODE,
		options: [{ value: "steer", label: t("queue.steer") }, { value: "followUp", label: t("queue.followUp") }],
		onChoose: (mode, focus) => void this.#chooseDelivery(mode, focus),
	});
	readonly #onEditProvider: (id?: string) => void;
	readonly #preferences: { key: Preference; input: HTMLInputElement }[] = [];
	readonly #instructionsPreview = h("span", { class: "fold-preview", id: "settings-instructions-preview" });
	readonly #instructionsDetails = h("details", { class: "fold", id: "settings-instructions-details" });
	readonly #instructions = h("textarea", {
		class: "instructions-input", id: "settings-instructions", rows: 9, spellcheck: "false",
		"aria-labelledby": "settings-instructions-label", "aria-describedby": "settings-instructions-status",
	});
	readonly #instructionsSave = h("button", { class: "btn primary small", id: "instructions-save", type: "button" }, t("settings.instructionsSave"));
	readonly #instructionsRestore = h("button", { class: "btn small", id: "instructions-restore", type: "button" }, t("settings.instructionsRestore"));
	readonly #instructionsLoadLatest = h("button", { class: "btn small", id: "instructions-load-latest", type: "button" }, t("settings.instructionsLoadLatest"));
	readonly #instructionsStatusText = h("span");
	readonly #instructionsStatus = h("div", { class: "instructions-status", id: "settings-instructions-status", role: "status", hidden: true }, this.#instructionsStatusText, this.#instructionsLoadLatest);
	readonly #restoreConfirm: ConfirmControl;
	#closed = false;
	#deliveryPending = false;
	#preferencePending = false;
	#instructionsPending = false;
	#instructionsDirty = false;
	#instructionsBaseline = "";
	/** The stored text a finished Save/Restore returned, until this panel observes it. */
	#instructionsAwaitingSync: string | undefined;

	constructor(source: () => Source | undefined, onClose: () => void, onEditProvider: (id?: string) => void) {
		this.#source = source;
		this.#onEditProvider = onEditProvider;
		this.#restoreConfirm = confirmControl(this.#instructionsRestore, {
			confirm: () => t("settings.instructionsRestoreConfirm"),
			idle: () => [t("settings.instructionsRestore")],
		});
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
			this.#restoreConfirm.reset();
			this.#refreshInstructions();
			this.#instructions.focus({ preventScroll: true });
		});
		this.#instructionsDetails.append(
			h("summary", null,
				h("span", { class: "fold-title", id: "settings-instructions-label" }, t("settings.instructions")),
				this.#instructionsPreview, icon("chevron", 14)),
			h("div", { class: "fold-body" },
				this.#instructions,
				h("div", { class: "provider-section-action" }, this.#instructionsSave, this.#instructionsRestore),
				this.#instructionsStatus));
		// A draft or a conflict notice must not be hidden by collapsing the section.
		this.#instructionsDetails.addEventListener("toggle", () => this.#keepInstructionsOpen());
		this.element = h(
			"section", { class: "sheet", id: "settings", role: "dialog", "aria-modal": "true", "aria-label": t("settings.title") },
			h("div", { class: "panel-head" },
				h("button", { class: "icon-btn", id: "settings-back", type: "button", "aria-label": t("settings.back"), onclick: onClose }, icon("back", 18)),
				h("span", { class: "panel-title" }, t("settings.title"))),
			h("div", { class: "sheet-body" },
				h("section", { class: "section" },
					h("div", { class: "section-heading" }, h("h3", null, t("settings.providers")),
						h("button", { class: "btn small", id: "add-provider", type: "button", onclick: () => this.#onEditProvider() }, icon("plus", 14), t("settings.addProvider"))),
					this.#card),
				h("section", { class: "section" }, h("h3", null, t("settings.safety")),
					h("div", { class: "card" }, this.#preference("confirmActions", t("settings.confirmActions")))),
				h("section", { class: "section" }, h("h3", null, t("settings.conversation")),
					h("div", { class: "card" },
						this.#preference("autoTitle", t("settings.autoTitle")),
						this.#preference("autoCompaction", t("settings.autoCompaction")),
						this.#preference("autoRetry", t("settings.autoRetry")))),
				h("section", { class: "section" }, h("h3", null, t("settings.messaging")), this.#delivery.element),
				h("section", { class: "section" }, h("h3", null, t("settings.appearance")), this.#themes()),
				h("section", { class: "section" }, h("h3", null, t("settings.language")), this.#languages()),
				h("section", { class: "section" }, this.#instructionsDetails),
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
		this.#restoreConfirm.reset();
	}

	#row(provider: ProviderSummary) {
		const status = provider.configured ? t("settings.configured") : t("settings.notConfigured");
		return h("div", { class: "provider", "data-provider": provider.id },
			h("button", {
				class: "provider-head", type: "button", "aria-haspopup": "dialog", "aria-label": `${provider.name}: ${status}`,
				onclick: () => this.#onEditProvider(provider.id),
			},
			h("span", { class: "provider-name" }, provider.name),
			provider.configured
				? h("span", { class: "status-dot", "data-on": true, "aria-hidden": "true" })
				: h("span", { class: "pill" }, status),
			icon("chevron", 14)),
		);
	}

	async #chooseDelivery(mode: BusyMode, focus = false) {
		if (this.#deliveryPending) return;
		const source = this.#source();
		if (!source) return toast(t("reconnecting"), "error");
		if (source.busyMode.value === mode) {
			if (focus) this.#delivery.select(mode, true);
			return;
		}
		this.#deliveryPending = true;
		this.#refreshDelivery();
		try {
			await source.setBusyMode(mode, context);
		} catch (error) {
			toastError(error);
		} finally {
			this.#deliveryPending = false;
			this.#refreshDelivery();
			if (focus) this.#delivery.select(this.#source()?.busyMode.value ?? mode, true);
		}
	}

	#refreshDelivery() {
		this.#delivery.select(this.#source()?.busyMode.value ?? DEFAULT_BUSY_MODE);
		this.#delivery.setDisabled(this.#deliveryPending);
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
			await source.setPreference({ key, enabled }, context);
		} catch (error) {
			toastError(error);
		} finally {
			this.#preferencePending = false;
			this.#refreshPreferences();
		}
	}

	#refreshPreferences() {
		const source = this.#source();
		for (const { key, input } of this.#preferences) {
			input.checked = source?.[key].value ?? PREFERENCE_DEFAULTS[key];
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
		const preview = this.#instructionsDirty ? t("settings.instructionsUnsaved") : (value ?? "").replace(/\s+/g, " ").trim();
		const clipped = !this.#instructionsDirty && preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
		if (this.#instructionsPreview.textContent !== clipped) this.#instructionsPreview.textContent = clipped;
		this.#instructionsPreview.dataset.dirty = String(this.#instructionsDirty);
		this.#keepInstructionsOpen();
		this.#instructions.disabled = this.#instructionsSave.disabled = this.#instructionsRestore.disabled = this.#instructionsLoadLatest.disabled = this.#instructionsPending || !source;
	}

	#keepInstructionsOpen() {
		if (this.#instructionsDirty || !this.#instructionsStatus.hidden) this.#instructionsDetails.open = true;
	}

	/** Save and Restore share one lifecycle; the Engine returns the text it stored, so normalization is never guessed. */
	async #mutateInstructions(instructions?: string) {
		if (this.#instructionsPending || this.#closed) return;
		this.#restoreConfirm.reset();
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
			toastError(error);
		} finally {
			this.#instructionsPending = false;
			this.#restoreConfirm.reset();
			this.#refreshInstructions();
		}
	}

	#restoreInstructions() {
		if (this.#instructionsPending || this.#closed) return;
		if (!this.#restoreConfirm.armed) return this.#restoreConfirm.arm();
		void this.#mutateInstructions();
	}

	#languages() {
		const picker = segmented<LanguagePreference>({
			id: "settings-language", label: t("settings.language"), selected: savedLanguagePreference(),
			options: [
				{ value: "system", label: t("settings.theme.system") },
				{ value: "zh-CN", label: "中文" },
				{ value: "en", label: "English" },
			],
			onChoose(language, focus) {
				picker.select(language, focus);
				if (language === savedLanguagePreference()) return;
				saveLanguage(language);
				location.reload();
			},
		});
		return picker.element;
	}

	#themes() {
		const picker = segmented<Theme>({
			label: t("settings.appearance"), selected: savedTheme(),
			options: (["system", "light", "dark"] as const).map((value) => ({ value, label: t(`settings.theme.${value}`) })),
			onChoose(theme, focus) {
				applyTheme(theme);
				picker.select(theme, focus);
			},
		});
		return picker.element;
	}
}
