import {
	THINKING_LEVELS, type ModelApi, type ModelConfig, type ModelSummary, type ProviderProfile, type ProviderSummary, type Workspace,
} from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { t } from "./i18n.ts";
import { compactTokens } from "./models.ts";
import { requestModelAccess } from "./model-permissions.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, toast } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"providers" | "saveProvider" | "deleteProvider" | "refreshProvider"
>;
const context = BACKGROUND_CONTEXT;
const DEFAULT_MODEL = (): ModelConfig => ({
	id: "", name: "", contextWindow: 128_000, maxTokens: 16_384, vision: false, thinkingLevels: ["off"],
});

export class ProviderEditorSheet implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: () => Source | undefined;
	readonly #id: string;
	readonly #existing: boolean;
	readonly #onClose: () => void;
	readonly #draft: ProviderProfile;
	readonly #key = h("input", { class: "input", id: "provider-key", type: "password", autocomplete: "off", spellcheck: "false" });
	readonly #manual = h("div", { class: "provider-models", id: "provider-manual-models" });
	readonly #discovered = h("div", { class: "provider-models", id: "provider-discovered-models" });
	readonly #status = h("p", { class: "section-hint", id: "provider-discovery-status", role: "status" });
	readonly #save = h("button", { class: "btn primary", id: "provider-save", type: "button" }, t("settings.save"));
	readonly #refresh = h("button", { class: "btn", id: "provider-refresh", type: "button" }, t("settings.refreshModels"));
	#closed = false;
	#busy = false;

	constructor(providerId: string | undefined, source: () => Source | undefined, onClose: () => void) {
		this.#source = source;
		this.#onClose = onClose;
		this.#id = providerId ?? `custom-${crypto.randomUUID()}`;
		this.#existing = providerId !== undefined;
		const existing = providerId ? this.#summary(providerId) : undefined;
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
		this.#key.placeholder = existing?.configured ? t("settings.keepKey") : t("settings.keyPlaceholder");
		const name = h("input", { class: "input", id: "provider-name", value: this.#draft.name, autocomplete: "off" });
		name.addEventListener("input", () => { this.#draft.name = name.value; });
		const baseUrl = h("input", { class: "input", id: "provider-base-url", value: this.#draft.baseUrl, placeholder: "https://example.com/v1", autocomplete: "off", spellcheck: "false" });
		baseUrl.addEventListener("input", () => { this.#draft.baseUrl = baseUrl.value; });
		const api = h("select", { class: "input", id: "provider-api" },
			h("option", { value: "openai-responses" }, "OpenAI Responses"),
			h("option", { value: "openai-completions" }, "OpenAI Chat Completions"),
			h("option", { value: "anthropic-messages" }, "Anthropic Messages"));
		api.value = this.#draft.api;
		api.addEventListener("change", () => { this.#draft.api = api.value as ModelApi; });
		const add = h("button", { class: "btn", id: "provider-add-model", type: "button", onclick: () => {
			this.#draft.models.push(DEFAULT_MODEL());
			this.#renderManual(true);
		} }, icon("plus", 14), t("settings.addModel"));
		this.#save.addEventListener("click", () => void this.#saveProvider());
		this.#refresh.addEventListener("click", () => void this.#refreshModels());
		this.#refresh.hidden = !this.#existing;
		this.element = h("section", { class: "sheet", id: "provider-editor", role: "dialog", "aria-modal": "true", "aria-label": t("settings.providerEditor") },
			h("div", { class: "panel-head" },
				h("button", { class: "icon-btn", id: "provider-back", type: "button", "aria-label": t("settings.back"), onclick: onClose }, icon("back", 18)),
				h("span", { class: "panel-title" }, this.#existing ? t("settings.editProvider") : t("settings.addProvider"))),
			h("div", { class: "sheet-body" },
				h("section", { class: "section" }, h("h3", null, t("settings.providerEditor")),
					h("div", { class: "card provider-editor-form" },
						this.#field(t("settings.providerName"), name),
						this.#field("Base URL", baseUrl),
						this.#field(t("settings.providerApi"), api),
						this.#field("API Key", this.#key))),
				h("section", { class: "section" },
					h("div", { class: "provider-actions" }, this.#save, this.#refresh, this.#existing ? this.#deleteButton(onClose) : null),
					this.#status),
				h("section", { class: "section" }, h("h3", null, t("settings.manualModels")), this.#manual,
					h("div", { class: "provider-section-action" }, add),
					h("p", { class: "section-hint" }, t("settings.manualModelsHint"))),
				h("section", { class: "section" }, h("h3", null, t("settings.discoveredModels")), this.#discovered),
			),
		);
		this.#renderManual();
		this.#setBusy(false);
		this.refresh();
	}

	#summary(id = this.#id) {
		return this.#source()?.providers.value.find((provider) => provider.id === id);
	}

	#field(label: string, input: HTMLElement) {
		return h("label", { class: "provider-field" }, h("span", null, label), input);
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
		const override = model.manual ? h("span", { class: "pill" }, t("settings.manual"))
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

	#deleteButton(onClose: () => void) {
		const button = h("button", { class: "btn danger", id: "provider-delete", type: "button" }, t("settings.deleteProvider"));
		button.addEventListener("click", async () => {
			if (button.dataset.confirm !== "true") {
				button.dataset.confirm = "true";
				button.textContent = t("settings.confirmDelete");
				return;
			}
			if (this.#busy) return;
			this.#setBusy(true, button);
			try {
				const source = this.#source();
				if (!source) throw new Error("The workspace is not ready.");
				await source.deleteProvider({ provider: this.#id }, context);
				toast(t("settings.providerDeleted"));
				onClose();
			} catch (error) {
				toast(String((error as Error)?.message ?? error), "error");
				delete button.dataset.confirm;
				button.textContent = t("settings.deleteProvider");
			} finally {
				this.#setBusy(false, button);
			}
		});
		return button;
	}

	async #saveProvider() {
		if (this.#busy) return;
		const key = this.#key.value.trim();
		if (this.#existing === false && !key) return toast(t("settings.keyRequired"), "error");
		const profile: ProviderProfile = {
			...this.#draft,
			name: this.#draft.name.trim(), baseUrl: this.#draft.baseUrl.trim(),
			models: this.#draft.models.map((model) => ({ ...model, name: model.name.trim() || model.id.trim(), thinkingLevels: model.thinkingLevels.length ? model.thinkingLevels : ["off"] })),
		};
		if (!profile.name || !profile.baseUrl || profile.models.some((model) => !model.id.trim())) {
			return toast(t("settings.completeFields"), "error");
		}
		// Start the browser permission request now, before the first await in this click path.
		const asked = requestModelAccess(profile.baseUrl);
		this.#setBusy(true, this.#save);
		try {
			if (!await asked) throw new Error(t("settings.permissionDenied"));
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			await source.saveProvider({ profile, ...(key ? { key } : {}) }, context);
			this.#key.value = "";
			toast(t("settings.providerSaved"));
			this.#onClose();
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#setBusy(false, this.#save);
		}
	}

	async #refreshModels() {
		if (this.#busy) return;
		const saved = this.#summary();
		if (!saved) return;
		const asked = requestModelAccess(saved.baseUrl);
		this.#setBusy(true, this.#refresh);
		try {
			if (!await asked) throw new Error(t("settings.permissionDenied"));
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			await source.refreshProvider({ provider: this.#id }, context);
			this.refresh();
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		} finally {
			this.#setBusy(false, this.#refresh);
		}
	}

	#setBusy(busy: boolean, button?: HTMLButtonElement) {
		this.#busy = busy;
		this.element.dataset.busy = String(busy);
		this.#save.disabled = busy;
		this.#refresh.disabled = busy;
		if (button) {
			button.toggleAttribute("aria-busy", busy);
			if (busy) button.prepend(h("span", { class: "spinner" }));
			else button.querySelector(".spinner")?.remove();
		}
	}

	refresh() {
		if (this.#closed) return;
		const summary = this.#summary();
		this.#status.textContent = summary?.refreshing ? t("settings.discovering")
			: summary?.discoveryError ?? (summary ? t("settings.discoveryReady", summary.models.length) : t("settings.unsavedProvider"));
		this.#discovered.replaceChildren(...(summary?.models.length
			? summary.models.map((model) => this.#modelRow(model))
			: [h("div", { class: "list-empty" }, t("settings.noDiscoveredModels"))]));
	}

	close() {
		this.#closed = true;
		this.#key.value = "";
	}
}
