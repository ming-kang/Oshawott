import {
	THINKING_LEVELS, type ModelApi, type ModelConfig, type ModelSummary, type ProviderProfile, type ProviderSummary, type Workspace,
} from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { t } from "./i18n.ts";
import { LoginCard, type LoginSource } from "./login-card.ts";
import { compactTokens } from "./models.ts";
import { requestModelAccess } from "./model-permissions.ts";
import type { OverlayView } from "./overlays.ts";
import { segmented } from "./segmented.ts";
import { h, icon, toast, toastError } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"providers" | "setApiKey" | "clearApiKey" | "saveProvider" | "deleteProvider" | "refreshProvider"
> & LoginSource;
type ProviderKind = "builtin" | "custom";
const context = BACKGROUND_CONTEXT;
/** Listed first, in this order, when the registry offers them. */
const WELL_KNOWN = ["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "github-copilot", "openai-codex", "mistral", "groq"];
const providerRank = (provider: ProviderSummary) => {
	const at = WELL_KNOWN.indexOf(provider.id);
	return at < 0 ? WELL_KNOWN.length : at;
};
const DEFAULT_MODEL = (): ModelConfig => ({
	id: "", name: "", contextWindow: 128_000, maxTokens: 16_384, vision: false, thinkingLevels: ["off"],
});

export class ProviderEditorSheet implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #id: string;
	readonly #onClose: () => void;
	readonly #draft: ProviderProfile;
	readonly #title = h("span", { class: "panel-title" });
	readonly #typeSection = h("section", { class: "section", id: "provider-type-section" });
	readonly #type = segmented<ProviderKind>({
		id: "provider-kind", label: t("settings.providerType"), selected: "builtin",
		options: [
			{ value: "builtin", label: t("settings.providerType.builtin"), id: "provider-kind-builtin" },
			{ value: "custom", label: t("settings.providerType.custom"), id: "provider-kind-custom" },
		],
		onChoose: (kind, focus) => this.#chooseKind(kind, focus),
	});
	readonly #form = h("div", { class: "card provider-editor-form" });
	readonly #search = h("input", {
		class: "input", id: "builtin-provider-search", type: "search", autocomplete: "off", spellcheck: "false",
		placeholder: t("settings.searchProviders"), "aria-label": t("settings.searchProviders"),
		role: "combobox", "aria-autocomplete": "list", "aria-expanded": "true", "aria-controls": "builtin-provider-list",
	});
	readonly #list = h("div", { class: "menu-list provider-list", id: "builtin-provider-list", role: "listbox", "aria-label": t("settings.builtinProvider") });
	readonly #picker = h("div", { class: "provider-picker" }, this.#search, this.#list);
	readonly #chosenName = h("span", { class: "provider-chosen-name" });
	readonly #chosenBadge = h("span", { class: "pill", "data-on": true, hidden: true }, t("settings.signInBadge"));
	readonly #change = h("button", { class: "btn small", id: "builtin-provider-change", type: "button" }, t("settings.changeProvider"));
	readonly #chosen = h("div", { class: "provider-chosen", id: "builtin-provider-chosen" }, this.#chosenName, this.#chosenBadge, this.#change);
	readonly #pickHint = h("p", { class: "section-hint", id: "builtin-provider-hint" }, t("settings.chooseProvider"));
	readonly #pickerField = h("div", { class: "provider-field", id: "builtin-provider-field" },
		h("span", null, t("settings.builtinProvider")), this.#chosen, this.#picker, this.#pickHint);
	readonly #name = h("input", { class: "input", id: "provider-name", autocomplete: "off" });
	readonly #baseUrl = h("input", { class: "input", id: "provider-base-url", placeholder: "https://example.com/v1", autocomplete: "off", spellcheck: "false" });
	readonly #api = h("select", { class: "input", id: "provider-api" },
		h("option", { value: "openai-responses" }, "OpenAI Responses"),
		h("option", { value: "openai-completions" }, "OpenAI Chat Completions"),
		h("option", { value: "anthropic-messages" }, "Anthropic Messages"));
	readonly #key = h("input", { class: "input", id: "provider-key", type: "password", autocomplete: "off", spellcheck: "false" });
	readonly #keyField = this.#field("API Key", this.#key);
	readonly #login: LoginCard;
	readonly #discoverySection = h("section", { class: "section", id: "provider-discovery" });
	readonly #manualSection = h("section", { class: "section", id: "provider-custom-models" });
	readonly #manual = h("div", { class: "provider-models", id: "provider-manual-models" });
	readonly #discovered = h("div", { class: "provider-models", id: "provider-discovered-models" });
	readonly #status = h("p", { class: "section-hint", id: "provider-discovery-status", role: "status" });
	readonly #save = h("button", { class: "btn primary", id: "provider-save", type: "button" }, t("settings.save"));
	readonly #refresh = h("button", { class: "btn small", id: "provider-refresh", type: "button" }, t("settings.getModels"));
	readonly #delete = h("button", { class: "btn danger", id: "provider-delete", type: "button", hidden: true }, t("settings.deleteProvider"));
	#kind: ProviderKind;
	#kindLocked: boolean;
	#builtinId = "";
	#listKey = "";
	#closed = false;
	#busy = false;

	constructor(providerId: string | undefined, source: () => Source | undefined, onClose: () => void) {
		this.#source = source;
		this.#onClose = onClose;
		this.#id = providerId ?? `custom-${crypto.randomUUID()}`;
		const existing = providerId ? this.#summary(providerId) : undefined;
		this.#kind = existing?.kind ?? "builtin";
		this.#kindLocked = providerId !== undefined;
		// A reopened panel returns to the sign-in the Engine is still running instead of starting another.
		const pending = providerId ? undefined : source()?.logins.value.find((login) => login.status === "pending");
		this.#builtinId = existing?.kind === "builtin" ? existing.id : pending?.provider ?? "";
		this.#login = new LoginCard(source, () => this.#kind === "builtin" ? this.#summary(this.#builtinId) : undefined, () => {
			this.#kindLocked = true;
			this.#renderKind();
		});
		this.#draft = {
			id: this.#id,
			name: existing?.name ?? "",
			baseUrl: existing?.baseUrl ?? "",
			api: existing?.api ?? "openai-responses",
			models: existing?.models.filter((model) => model.manual).map((model) => ({
				id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
				vision: model.vision, thinkingLevels: [...model.thinkingLevels],
			})) ?? [],
		};
		this.#name.value = this.#draft.name;
		this.#name.addEventListener("input", () => { this.#draft.name = this.#name.value; });
		this.#baseUrl.value = this.#draft.baseUrl;
		this.#baseUrl.addEventListener("input", () => { this.#draft.baseUrl = this.#baseUrl.value; });
		this.#api.value = this.#draft.api;
		this.#api.addEventListener("change", () => { this.#draft.api = this.#api.value as ModelApi; });
		this.#search.addEventListener("input", () => this.#renderList());
		this.#search.addEventListener("keydown", (event) => this.#searchKey(event));
		this.#change.addEventListener("click", () => this.#changeProvider());
		this.#save.addEventListener("click", () => void this.#saveProvider());
		this.#refresh.addEventListener("click", () => void this.#discoverModels());
		this.#delete.addEventListener("click", () => void this.#removeProvider());
		const add = h("button", { class: "btn", id: "provider-add-model", type: "button", onclick: () => {
			this.#draft.models.push(DEFAULT_MODEL());
			this.#renderManual(true);
		} }, icon("plus", 14), t("settings.addModel"));
		this.#typeSection.append(h("h3", null, t("settings.providerType")), this.#type.element);
		this.#discoverySection.append(
			h("div", { class: "section-heading" }, h("h3", null, t("settings.discoveredModels")), this.#refresh),
			this.#discovered, this.#status,
		);
		this.#manualSection.append(h("h3", null, t("settings.manualModels")), this.#manual,
			h("div", { class: "provider-section-action" }, add),
			h("p", { class: "section-hint" }, t("settings.manualModelsHint")));
		this.element = h("section", { class: "sheet", id: "provider-editor", role: "dialog", "aria-modal": "true", "aria-label": t("settings.providerEditor") },
			h("div", { class: "panel-head" },
				h("button", { class: "icon-btn", id: "provider-back", type: "button", "aria-label": t("settings.back"), onclick: onClose }, icon("back", 18)),
				this.#title),
			h("div", { class: "sheet-body" },
				this.#typeSection,
				h("section", { class: "section" }, h("h3", null, t("settings.providerEditor")), this.#form),
				this.#discoverySection,
				this.#manualSection,
				h("section", { class: "section provider-footer" }, h("div", { class: "provider-actions" }, this.#save, this.#delete)),
			),
		);
		this.#renderManual();
		this.#renderKind();
		this.refresh();
	}

	#summary(id = this.#id): ProviderSummary | undefined {
		return this.#source()?.providers.value.find((provider) => provider.id === id);
	}

	#currentSummary(): ProviderSummary | undefined {
		return this.#kind === "builtin" ? this.#summary(this.#builtinId) : this.#summary();
	}

	#field(label: string, input: HTMLElement) {
		return h("label", { class: "provider-field" }, h("span", null, label), input);
	}

	#chooseKind(kind: ProviderKind, focus = false) {
		if (this.#kindLocked || this.#busy) return;
		this.#kind = kind;
		this.#renderKind();
		if (focus) this.#type.select(kind, true);
	}

	#renderKind() {
		this.#title.textContent = this.#kindLocked ? t("settings.editProvider") : t("settings.addProvider");
		this.#typeSection.hidden = this.#kindLocked;
		this.#type.select(this.#kind);
		this.#form.replaceChildren(...(this.#kind === "builtin" ? [
			this.#pickerField,
			this.#keyField,
			this.#login.element,
		] : [
			this.#field(t("settings.providerName"), this.#name),
			this.#field(t("settings.providerEndpoint"), this.#baseUrl),
			this.#field(t("settings.providerApi"), this.#api),
			this.#keyField,
		]));
		this.#manualSection.hidden = this.#kind !== "custom";
		delete this.#delete.dataset.confirm;
		this.#delete.textContent = t("settings.deleteProvider");
		this.refresh();
		this.#setBusy(this.#busy);
	}

	#refreshPicker() {
		// A provider being signed in to stays selected although it becomes configured mid-flow.
		const session = this.#login.session;
		const pinned = this.#kindLocked || session !== undefined;
		const offered = (this.#source()?.providers.value ?? []).filter((provider) => provider.kind === "builtin"
			&& (pinned ? provider.id === this.#builtinId : !provider.configured));
		const chosen = offered.find((provider) => provider.id === this.#builtinId);
		if (!chosen) this.#builtinId = "";
		this.#chosen.hidden = !chosen;
		this.#chosen.dataset.provider = chosen?.id ?? "";
		this.#chosenName.textContent = chosen?.name ?? "";
		this.#chosenBadge.hidden = !chosen?.oauth;
		this.#change.hidden = this.#kindLocked || (session !== undefined && session.status !== "failed");
		this.#change.disabled = this.#search.disabled = this.#busy;
		this.#picker.hidden = chosen !== undefined;
		this.#pickHint.hidden = chosen !== undefined || offered.length === 0;
		this.#search.hidden = offered.length === 0;
		if (!chosen) this.#renderList(offered);
	}

	#renderList(offered = (this.#source()?.providers.value ?? []).filter((provider) => provider.kind === "builtin" && !provider.configured)) {
		const query = this.#search.value.trim().toLowerCase();
		const providers = offered
			.filter((provider) => !query || `${provider.name} ${provider.id}`.toLowerCase().includes(query))
			.sort((a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name));
		// Rebuilt only when what is listed changes, so a refresh never resets the scroll position or highlight.
		const key = JSON.stringify([query, providers.map((provider) => [provider.id, provider.name, provider.oauth !== null, provider.apiKey])]);
		if (key === this.#listKey) return;
		this.#listKey = key;
		const items = providers.map((provider, index) => h("button", {
			class: "menu-item provider-option", id: `builtin-provider-option-${index}`, type: "button", role: "option", tabindex: -1,
			"aria-selected": "false", "data-provider": provider.id, onclick: () => this.#pick(provider.id),
		}, h("span", { class: "menu-item-name" }, provider.name,
			provider.apiKey ? null : h("span", { class: "menu-item-details" }, t("settings.signInOnly"))),
		provider.oauth ? h("span", { class: "pill", "data-on": true }, t("settings.signInBadge")) : null));
		this.#list.replaceChildren(...(items.length
			? items
			: [h("div", { class: "list-empty", role: "status" }, t(query ? "settings.noProviderMatch" : "settings.noBuiltinProviders"))]));
		this.#activate(items[0]);
	}

	#items() {
		return [...this.#list.querySelectorAll<HTMLButtonElement>(".provider-option")];
	}

	#activate(item: HTMLButtonElement | undefined) {
		for (const other of this.#items()) other.classList.toggle("active", other === item);
		if (item) this.#search.setAttribute("aria-activedescendant", item.id);
		else this.#search.removeAttribute("aria-activedescendant");
		item?.scrollIntoView({ block: "nearest" });
	}

	#searchKey(event: KeyboardEvent) {
		const items = this.#items();
		const at = items.findIndex((item) => item.classList.contains("active"));
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			this.#activate(items[Math.max(0, Math.min(items.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]);
		} else if (event.key === "Enter") {
			event.preventDefault();
			items[at]?.click();
		}
	}

	#pick(id: string) {
		if (this.#busy) return;
		this.#builtinId = id;
		this.#key.value = "";
		this.#search.value = "";
		this.refresh();
		this.#setBusy(this.#busy);
		(this.#keyField.hidden ? this.#login.element.querySelector("button") : this.#key)?.focus({ preventScroll: true });
	}

	#changeProvider() {
		if (this.#busy) return;
		this.#builtinId = "";
		this.#key.value = "";
		this.refresh();
		this.#setBusy(this.#busy);
		this.#search.focus({ preventScroll: true });
	}

	#updateKeyPlaceholder() {
		this.#key.placeholder = this.#currentSummary()?.configured ? t("settings.keepKey") : t("settings.keyPlaceholder");
	}

	#updateDeleteVisibility() {
		const summary = this.#currentSummary();
		this.#delete.hidden = !summary || (this.#kind === "builtin" && !summary.configured);
	}

	#renderManual(focusLast = false) {
		this.#manual.replaceChildren(...(this.#draft.models.length
			? this.#draft.models.map((model, index) => this.#modelEditor(model, index))
			: [h("div", { class: "list-empty" }, t("settings.noManualModels"))]));
		if (focusLast) this.#manual.querySelector<HTMLInputElement>("details:last-child input")?.focus();
	}

	#modelEditor(model: ModelConfig, index: number) {
		const id = h("input", { class: "input", value: model.id, placeholder: "model-id", "aria-label": t("settings.modelId") });
		id.addEventListener("input", () => { model.id = id.value; });
		const name = h("input", { class: "input", value: model.name, placeholder: model.id || "Model", "aria-label": t("settings.modelName") });
		name.addEventListener("input", () => { model.name = name.value; });
		const contextWindow = h("input", { class: "input", type: "number", min: 1, step: 1, value: model.contextWindow, "aria-label": t("settings.contextWindow") });
		contextWindow.addEventListener("input", () => { model.contextWindow = Number(contextWindow.value); });
		const maxTokens = h("input", { class: "input", type: "number", min: 1, step: 1, value: model.maxTokens, "aria-label": t("settings.maxTokens") });
		maxTokens.addEventListener("input", () => { model.maxTokens = Number(maxTokens.value); });
		const vision = h("input", { type: "checkbox", checked: model.vision });
		vision.addEventListener("change", () => { model.vision = vision.checked; });
		const levels = h("div", { class: "thinking-checks" }, ...THINKING_LEVELS.map((level) => {
			const input = h("input", { type: "checkbox", checked: model.thinkingLevels.includes(level) });
			input.addEventListener("change", () => {
				model.thinkingLevels = input.checked ? [...model.thinkingLevels, level] : model.thinkingLevels.filter((item) => item !== level);
			});
			return h("label", null, input, t(`thinking.level.${level}`));
		}));
		const remove = h("button", { class: "btn danger small", type: "button", onclick: () => {
			this.#draft.models.splice(index, 1);
			this.#renderManual();
		} }, t("settings.removeModel"));
		return h("details", { class: "model-editor", open: !model.id },
			h("summary", null, model.id || t("settings.newModel")),
			h("div", { class: "model-editor-grid" },
				this.#field(t("settings.modelId"), id), this.#field(t("settings.modelName"), name),
				this.#field(t("settings.contextWindow"), contextWindow), this.#field(t("settings.maxTokens"), maxTokens),
				h("label", { class: "vision-check" }, vision, t("settings.visionCapable")),
				h("div", { class: "model-thinking" }, h("span", null, t("settings.supportedThinking")), levels),
				remove));
	}

	#modelRow(model: ModelSummary) {
		const override = this.#kind === "builtin" ? null : model.manual ? h("span", { class: "pill" }, t("settings.manual"))
			: h("button", { class: "btn small", type: "button", onclick: () => {
				this.#draft.models.push({
					id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
					vision: model.vision, thinkingLevels: [...model.thinkingLevels],
				});
				this.#renderManual(true);
			} }, t("settings.override"));
		return h("div", { class: "discovered-model", "data-model": model.id },
			h("div", null, h("strong", null, model.name), h("span", null, model.id)),
			h("span", { class: "model-capabilities" }, `${compactTokens(model.contextWindow)} · ${model.vision ? t("settings.vision") : t("settings.textOnly")}`),
			override);
	}

	async #saveProvider() {
		if (this.#busy) return;
		if (this.#kind === "custom") {
			await this.#persistCustom(false);
			return;
		}
		const provider = this.#currentSummary();
		if (!provider) return toast(t("settings.noBuiltinProviders"), "error");
		const key = this.#key.value.trim();
		if (!key) {
			if (provider.configured) this.#onClose();
			else toast(t("settings.keyRequired"), "error");
			return;
		}
		const asked = requestModelAccess(provider.baseUrl);
		this.#setBusy(true, this.#save);
		try {
			if (!await asked) throw new Error(t("settings.permissionDenied"));
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			await source.setApiKey({ provider: provider.id, key }, context);
			this.#key.value = "";
			toast(t("settings.providerSaved"));
			this.#onClose();
		} catch (error) {
			toastError(error);
		} finally {
			this.#setBusy(false, this.#save);
		}
	}

	async #discoverModels() {
		if (this.#busy) return;
		if (this.#kind === "custom") return void await this.#persistCustom(true);
		const provider = this.#currentSummary();
		if (!provider) return;
		this.#setBusy(true, this.#refresh);
		try {
			await this.#source()?.refreshProvider({ provider: provider.id }, context);
		} catch (error) {
			toastError(error);
		} finally {
			this.#setBusy(false, this.#refresh);
		}
	}

	async #persistCustom(discover: boolean) {
		const key = this.#key.value.trim();
		const profile: ProviderProfile = {
			...this.#draft,
			name: this.#draft.name.trim(), baseUrl: this.#draft.baseUrl.trim(),
			models: this.#draft.models.map((model) => ({ ...model, name: model.name.trim() || model.id.trim(), thinkingLevels: model.thinkingLevels.length ? model.thinkingLevels : ["off"] })),
		};
		if (!profile.name || !profile.baseUrl || profile.models.some((model) => !model.id.trim())) {
			toast(t("settings.completeFields"), "error");
			return false;
		}
		if (!this.#summary()?.configured && !key) {
			toast(t("settings.keyRequired"), "error");
			return false;
		}
		const asked = requestModelAccess(profile.baseUrl);
		const button = discover ? this.#refresh : this.#save;
		this.#setBusy(true, button);
		try {
			if (!await asked) throw new Error(t("settings.permissionDenied"));
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			await source.saveProvider({ profile, ...(key ? { key } : {}) }, context);
			this.#kindLocked = true;
			this.#key.value = "";
			if (discover && !key) await source.refreshProvider({ provider: this.#id }, context);
			this.#renderKind();
			this.refresh();
			if (!discover) {
				toast(t("settings.providerSaved"));
				this.#onClose();
			}
			return true;
		} catch (error) {
			toastError(error);
			return false;
		} finally {
			this.#setBusy(false, button);
		}
	}

	async #removeProvider() {
		const provider = this.#currentSummary();
		if (!provider || this.#busy) return;
		if (this.#kind === "custom" && this.#delete.dataset.confirm !== "true") {
			this.#delete.dataset.confirm = "true";
			this.#delete.textContent = t("settings.confirmDelete");
			return;
		}
		this.#setBusy(true, this.#delete);
		try {
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			if (this.#kind === "builtin") await source.clearApiKey({ provider: provider.id }, context);
			else await source.deleteProvider({ provider: provider.id }, context);
			toast(t("settings.providerDeleted"));
			this.#onClose();
		} catch (error) {
			toastError(error);
			delete this.#delete.dataset.confirm;
			this.#delete.textContent = t("settings.deleteProvider");
		} finally {
			this.#setBusy(false, this.#delete);
		}
	}

	#setBusy(busy: boolean, button?: HTMLButtonElement) {
		this.#busy = busy;
		this.element.dataset.busy = String(busy);
		this.#save.disabled = busy || (this.#kind === "builtin" && !this.#builtinId);
		this.#refresh.disabled = busy || this.#currentSummary()?.refreshing === true;
		this.#delete.disabled = busy;
		this.#search.disabled = this.#change.disabled = busy;
this.#type.setDisabled(busy || this.#kindLocked);
		if (button) {
			button.toggleAttribute("aria-busy", busy);
			if (busy) button.prepend(h("span", { class: "spinner" }));
			else button.querySelector(".spinner")?.remove();
		}
	}

	refresh() {
		if (this.#closed) return;
		this.#refreshPicker();
		const summary = this.#currentSummary();
		const builtin = this.#kind === "builtin";
		this.#login.refresh();
		// Nothing but the picker is offered until a built-in provider has been chosen.
		this.#keyField.hidden = builtin && (!summary || summary.apiKey === false);
		this.#save.hidden = this.#keyField.hidden;
		// A configured built-in provider lists what its key or account may use; only custom catalogs are editable.
		this.#discoverySection.hidden = builtin && !summary?.configured;
		this.#status.textContent = summary?.refreshing ? t("settings.discovering")
			: summary?.discoveryError ?? (summary ? t("settings.discoveryReady", summary.models.length) : t("settings.unsavedProvider"));
		this.#discovered.replaceChildren(...(summary?.models.length
			? summary.models.map((model) => this.#modelRow(model))
			: [h("div", { class: "list-empty" }, t("settings.noDiscoveredModels"))]));
		this.#refresh.textContent = summary?.refreshing ? t("settings.discovering") : t("settings.getModels");
		this.#refresh.disabled = this.#busy || summary?.refreshing === true;
		this.#updateKeyPlaceholder();
		this.#updateDeleteVisibility();
	}

	close() {
		this.#closed = true;
		this.#key.value = "";
	}
}
