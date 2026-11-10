import {
	THINKING_LEVELS, type ModelApi, type ModelConfig, type ModelSummary, type ProviderProfile, type ProviderSummary, type Workspace,
} from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { t } from "./i18n.ts";
import { LoginCard, type LoginSource } from "./login-card.ts";
import { compactTokens } from "./models.ts";
import { requestModelAccess } from "./model-permissions.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, toast } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"providers" | "setApiKey" | "clearApiKey" | "saveProvider" | "deleteProvider" | "refreshProvider"
> & LoginSource;
type ProviderKind = "builtin" | "custom";
const context = BACKGROUND_CONTEXT;
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
	readonly #type = h("div", { class: "segmented", id: "provider-kind", role: "radiogroup", "aria-label": t("settings.providerType") });
	readonly #form = h("div", { class: "card provider-editor-form" });
	readonly #builtinPicker = h("select", { class: "input", id: "builtin-provider-picker", "aria-label": t("settings.builtinProvider") });
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
		this.#builtinPicker.addEventListener("change", () => {
			this.#builtinId = this.#builtinPicker.value;
			this.refresh();
			this.#setBusy(this.#busy);
		});
		this.#buildTypePicker();
		this.#save.addEventListener("click", () => void this.#saveProvider());
		this.#refresh.addEventListener("click", () => void this.#discoverModels());
		this.#delete.addEventListener("click", () => void this.#removeProvider());
		const add = h("button", { class: "btn", id: "provider-add-model", type: "button", onclick: () => {
			this.#draft.models.push(DEFAULT_MODEL());
			this.#renderManual(true);
		} }, icon("plus", 14), t("settings.addModel"));
		this.#typeSection.append(h("h3", null, t("settings.providerType")), this.#type);
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

	#buildTypePicker() {
		const kinds: ProviderKind[] = ["builtin", "custom"];
		for (const [index, kind] of kinds.entries()) {
			this.#type.append(h("button", {
				type: "button", id: `provider-kind-${kind}`, role: "radio", "data-value": kind,
				"aria-checked": String(this.#kind === kind), tabindex: this.#kind === kind ? 0 : -1,
				onclick: () => this.#chooseKind(kind),
				onkeydown: (event: KeyboardEvent) => {
					const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % kinds.length
						: event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + kinds.length - 1) % kinds.length
							: event.key === "Home" ? 0 : event.key === "End" ? kinds.length - 1 : -1;
					if (next < 0) return;
					event.preventDefault();
					this.#chooseKind(kinds[next]!, true);
				},
			}, t(kind === "builtin" ? "settings.providerType.builtin" : "settings.providerType.custom")));
		}
	}

	#chooseKind(kind: ProviderKind, focus = false) {
		if (this.#kindLocked || this.#busy) return;
		this.#kind = kind;
		this.#renderKind();
		if (focus) this.#type.querySelector<HTMLButtonElement>(`[data-value="${kind}"]`)?.focus({ preventScroll: true });
	}

	#renderKind() {
		this.#title.textContent = this.#kindLocked ? t("settings.editProvider") : t("settings.addProvider");
		this.#typeSection.hidden = this.#kindLocked;
		for (const button of this.#type.querySelectorAll<HTMLButtonElement>("button")) {
			const selected = button.dataset.value === this.#kind;
			button.setAttribute("aria-checked", String(selected));
			button.tabIndex = selected ? 0 : -1;
		}
		this.#form.replaceChildren(...(this.#kind === "builtin" ? [
			this.#field(t("settings.builtinProvider"), this.#builtinPicker),
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

	#refreshBuiltinOptions() {
		const selected = this.#builtinId;
		// A provider being signed in to stays selected although it becomes configured mid-flow.
		const pinned = this.#kindLocked || this.#login.session !== undefined;
		const providers = (this.#source()?.providers.value ?? []).filter((provider) => provider.kind === "builtin"
			&& (pinned ? provider.id === selected : !provider.configured));
		this.#builtinPicker.replaceChildren(...(providers.length
			? providers.map((provider) => h("option", { value: provider.id }, provider.name))
			: [h("option", { value: "" }, t("settings.noBuiltinProviders"))]));
		if (providers.some((provider) => provider.id === selected)) this.#builtinPicker.value = selected;
		this.#builtinId = this.#builtinPicker.value;
		this.#builtinPicker.disabled = this.#busy || this.#kindLocked || !this.#builtinId;
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
			toast(String((error as Error)?.message ?? error), "error");
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
			toast(String((error as Error)?.message ?? error), "error");
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
			toast(String((error as Error)?.message ?? error), "error");
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
			toast(String((error as Error)?.message ?? error), "error");
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
		this.#builtinPicker.disabled = busy || this.#kindLocked || !this.#builtinId;
		for (const choice of this.#type.querySelectorAll<HTMLButtonElement>("button")) choice.disabled = busy || this.#kindLocked;
		if (button) {
			button.toggleAttribute("aria-busy", busy);
			if (busy) button.prepend(h("span", { class: "spinner" }));
			else button.querySelector(".spinner")?.remove();
		}
	}

	refresh() {
		if (this.#closed) return;
		this.#refreshBuiltinOptions();
		const summary = this.#currentSummary();
		const builtin = this.#kind === "builtin";
		this.#login.refresh();
		this.#keyField.hidden = builtin && summary?.apiKey === false;
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
