import {
	THINKING_LEVELS, type ModelApi, type ModelConfig, type ModelSummary, type ProviderProfile, type ProviderSummary, type Workspace,
} from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { type BuiltinCandidate, type BuiltinFieldChange, computeBuiltinChanges, matchBuiltinModels } from "./builtin-match.ts";
import { comboboxNav } from "./combobox.ts";
import { t } from "./i18n/index.ts";
import { LoginCard, type LoginSource } from "./login-card.ts";
import { compactTokens } from "./models.ts";
import { requestModelAccess } from "./model-permissions.ts";
import type { OverlayView } from "./overlays.ts";
import { segmented } from "./segmented.ts";
import { confirmControl, type ConfirmControl, h, icon, toast, toastError } from "./ui.ts";

type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"providers" | "setApiKey" | "saveProvider" | "deleteProvider" | "refreshProvider" | "probeModels"
> & LoginSource;
type ProviderKind = "builtin" | "custom";
type FetchState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "results"; models: ModelConfig[]; truncated: boolean };

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
const REQUEST_PATHS: Readonly<Record<ModelApi, string>> = {
	"anthropic-messages": "/v1/messages",
	"openai-responses": "/responses",
	"openai-completions": "/chat/completions",
};

function baseUrlPlaceholder(api: ModelApi): string {
	return api === "anthropic-messages" ? "https://api.example.com" : "https://api.example.com/v1";
}

function validEndpointUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.username || url.password || url.search || url.hash) return undefined;
		return url.href.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

function connectionNote(api: ModelApi, rawUrl: string): { text: string; warning: boolean } | undefined {
	const base = validEndpointUrl(rawUrl);
	if (!base) return undefined;
	const target = `${base}${REQUEST_PATHS[api]}`;
	const doubled = api === "anthropic-messages" && /\/v1$/i.test(base);
	return { text: t(doubled ? "settings.endpointDoubleV1" : "settings.endpointHint", target), warning: doubled };
}

function modelCapabilitiesText(model: Pick<ModelConfig, "contextWindow" | "maxTokens" | "vision" | "thinkingLevels">, includeMaxTokens = false): string {
	const hasThinking = model.thinkingLevels.some((level) => level !== "off");
	return [
		compactTokens(model.contextWindow),
		includeMaxTokens ? `${compactTokens(model.maxTokens)} out` : "",
		model.vision ? t("settings.vision") : "",
		hasThinking ? t("settings.thinking") : "",
	].filter(Boolean).join(" · ");
}

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
	readonly #nav = comboboxNav(this.#search, this.#list, ".provider-option");
	readonly #picker = h("div", { class: "provider-picker" }, this.#search, this.#list);
	readonly #chosenName = h("span", { class: "provider-chosen-name" });
	readonly #chosenBadge = h("span", { class: "pill", "data-on": true, hidden: true }, t("settings.signInBadge"));
	readonly #change = h("button", { class: "btn small", id: "builtin-provider-change", type: "button" }, t("settings.changeProvider"));
	readonly #chosen = h("div", { class: "provider-chosen", id: "builtin-provider-chosen" }, this.#chosenName, this.#chosenBadge, this.#change);
	readonly #pickerField = h("div", { class: "provider-field", id: "builtin-provider-field" },
		h("span", null, t("settings.builtinProvider")), this.#chosen, this.#picker);
	readonly #name = h("input", { class: "input", id: "provider-name", autocomplete: "off" });
	readonly #baseUrl = h("input", { class: "input", id: "provider-base-url", placeholder: baseUrlPlaceholder("openai-responses"), autocomplete: "off", spellcheck: "false" });
	readonly #endpointHint = h("span", { class: "provider-field-note", id: "provider-endpoint-hint", hidden: true });
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
	readonly #status = h("p", { class: "provider-status", id: "provider-discovery-status", role: "status", hidden: true });
	readonly #save = h("button", { class: "btn primary", id: "provider-save", type: "button" }, t("settings.save"));
	readonly #builtinRefresh = h("button", { class: "btn small", id: "builtin-provider-refresh", type: "button" }, t("settings.getModels"));
	readonly #customFetch = h("button", { class: "btn small", id: "provider-refresh", type: "button" }, t("settings.getModels"));
	readonly #delete = h("button", { class: "btn danger", id: "provider-delete", type: "button", hidden: true }, t("settings.deleteProvider"));
	readonly #deleteConfirm: ConfirmControl;

	readonly #fetchPanel = h("div", { class: "card provider-fetch-panel", id: "provider-fetch-panel", hidden: true });
	readonly #fetchHeaderTitle = h("strong", { class: "provider-fetch-title" }, t("settings.fetchTitle"));
	readonly #fetchHeaderCount = h("span", { class: "provider-fetch-count" });
	readonly #fetchClose = h("button", { class: "icon-btn small", id: "provider-fetch-close", type: "button", "aria-label": t("settings.cancel") }, icon("x", 14));
	readonly #fetchStatus = h("p", { class: "provider-status", id: "provider-fetch-status", role: "status", hidden: true });
	readonly #fetchSearch = h("input", {
		class: "input", id: "provider-fetch-search", type: "search", autocomplete: "off", spellcheck: "false",
		placeholder: t("settings.fetchSearch"), "aria-label": t("settings.fetchSearch"),
	});
	readonly #fetchSelectAll = h("button", { class: "btn small", id: "provider-fetch-select-all", type: "button" });
	readonly #fetchSelected = h("span", { class: "provider-fetch-selected" });
	readonly #fetchToolbar = h("div", { class: "provider-fetch-toolbar" }, this.#fetchSelectAll, this.#fetchSelected);
	readonly #fetchList = h("div", { class: "provider-fetch-list", id: "provider-fetch-list", role: "group", "aria-label": t("settings.fetchTitle") });
	readonly #fetchTruncated = h("p", { class: "provider-fetch-note", hidden: true }, t("settings.fetchTruncated"));
	readonly #fetchImport = h("button", { class: "btn primary small", id: "provider-import-models", type: "button" });
	readonly #fetchCancel = h("button", { class: "btn small", id: "provider-fetch-cancel", type: "button" }, t("settings.cancel"));
	readonly #fetchBody = h("div", { class: "provider-fetch-body" },
		this.#fetchSearch,
		this.#fetchToolbar,
		this.#fetchList,
		this.#fetchTruncated,
		h("div", { class: "provider-fetch-actions" }, this.#fetchImport, this.#fetchCancel),
	);

	#kind: ProviderKind;
	#kindLocked: boolean;
	#builtinId = "";
	#listKey = "";
	#closed = false;
	#busy = false;
	#fetchState: FetchState = { kind: "idle" };
	#fetchChecked = new Set<string>();

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
			models: existing?.models.map((model) => ({
				id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
				vision: model.vision, thinkingLevels: [...model.thinkingLevels],
			})) ?? [],
		};
		this.#name.value = this.#draft.name;
		this.#name.addEventListener("input", () => { this.#draft.name = this.#name.value; });
		this.#baseUrl.value = this.#draft.baseUrl;
		this.#baseUrl.addEventListener("input", () => {
			this.#draft.baseUrl = this.#baseUrl.value;
			this.#updateEndpointHint();
		});
		this.#api.value = this.#draft.api;
		this.#api.addEventListener("change", () => {
			this.#draft.api = this.#api.value as ModelApi;
			this.#updateEndpointHint();
		});
		this.#search.addEventListener("input", () => this.#renderList());
		this.#search.addEventListener("keydown", (event) => this.#nav.onKeydown(event));
		this.#change.addEventListener("click", () => this.#changeProvider());
		this.#save.addEventListener("click", () => void this.#saveProvider());
		this.#builtinRefresh.addEventListener("click", () => void this.#discoverBuiltinModels());
		this.#customFetch.addEventListener("click", () => void this.#probeCustomModels());
		this.#delete.addEventListener("click", () => void this.#removeProvider());
		this.#fetchSearch.addEventListener("input", () => this.#renderFetchResults());
		this.#fetchSelectAll.addEventListener("click", () => this.#toggleFetchSelectAll());
		this.#fetchImport.addEventListener("click", () => this.#importSelectedModels());
		this.#fetchCancel.addEventListener("click", () => this.#closeFetchPanel());
		this.#fetchClose.addEventListener("click", () => this.#closeFetchPanel());
		const add = h("button", { class: "btn small", id: "provider-add-model", type: "button", onclick: () => {
			this.#draft.models.push(DEFAULT_MODEL());
			this.#renderManual(true);
		} }, icon("plus", 14), t("settings.addModel"));
		this.#deleteConfirm = confirmControl(this.#delete, {
			confirm: () => t("settings.confirmDelete"),
			idle: () => [t("settings.deleteProvider")],
		});
		this.#fetchPanel.append(
			h("div", { class: "provider-fetch-head" },
				h("div", { class: "provider-fetch-title-row" }, this.#fetchHeaderTitle, this.#fetchHeaderCount),
				this.#fetchClose),
			this.#fetchStatus,
			this.#fetchBody,
		);
		this.#typeSection.append(h("h3", null, t("settings.providerType")), this.#type.element);
		this.#discoverySection.append(
			h("div", { class: "section-heading" }, h("h3", null, t("settings.discoveredModels")), this.#builtinRefresh),
			this.#discovered, this.#status,
		);
		this.#manualSection.append(
			h("div", { class: "section-heading" },
				h("h3", null, t("settings.models")),
				h("div", { class: "section-heading-actions" }, this.#customFetch, add)),
			this.#fetchPanel,
			this.#manual,
		);
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
		this.#updateEndpointHint();
		this.#renderFetchPanel();
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
			h("div", { class: "provider-field-group" }, this.#field(t("settings.providerEndpoint"), this.#baseUrl), this.#endpointHint),
			this.#field(t("settings.providerApi"), this.#api),
			this.#keyField,
		]));
		this.#manualSection.hidden = this.#kind !== "custom";
		this.#deleteConfirm.reset();
		this.refresh();
		this.#setBusy(this.#busy);
	}

	#updateEndpointHint() {
		this.#baseUrl.placeholder = baseUrlPlaceholder(this.#draft.api);
		const note = connectionNote(this.#draft.api, this.#baseUrl.value);
		this.#endpointHint.hidden = !note;
		this.#endpointHint.textContent = note?.text ?? "";
		this.#endpointHint.dataset.warning = String(Boolean(note?.warning));
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
		this.#nav.activate(items[0]);
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
			: [h("div", { class: "list-empty" }, t("settings.noModels"))]));
		if (focusLast) this.#manual.querySelector<HTMLInputElement>("details:last-child input")?.focus();
		if (this.#fetchState.kind === "results") this.#renderFetchResults();
	}

	#modelEditor(model: ModelConfig, index: number) {
		const title = h("strong", { class: "model-editor-title" });
		const meta = h("span", { class: "model-editor-meta" });
		const summary = h("summary", { class: "model-editor-summary" }, title, meta);
		const syncSummary = () => {
			const idText = model.id.trim();
			const nameText = model.name.trim();
			title.textContent = nameText || idText || t("settings.newModel");
			const sub = idText && nameText && nameText !== idText ? idText : "";
			const caps = modelCapabilitiesText(model);
			meta.textContent = [sub, caps].filter(Boolean).join(" · ");
		};

		const id = h("input", { class: "input", value: model.id, placeholder: "model-id", "aria-label": t("settings.modelId") });
		const name = h("input", { class: "input", value: model.name, placeholder: model.id || "Model", "aria-label": t("settings.modelName") });
		const contextWindow = h("input", { class: "input", type: "number", min: 1, step: 1, value: model.contextWindow, "aria-label": t("settings.contextWindow") });
		const maxTokens = h("input", { class: "input", type: "number", min: 1, step: 1, value: model.maxTokens, "aria-label": t("settings.maxTokens") });
		const vision = h("input", { type: "checkbox", checked: model.vision });
		const levelInputs = THINKING_LEVELS.map((level) => {
			const input = h("input", { type: "checkbox", checked: model.thinkingLevels.includes(level) });
			input.addEventListener("change", () => {
				model.thinkingLevels = input.checked
					? THINKING_LEVELS.filter((item) => item === level || model.thinkingLevels.includes(item))
					: model.thinkingLevels.filter((item) => item !== level);
				syncSummary();
			});
			return { level, input, label: h("label", null, input, t(`thinking.level.${level}`)) };
		});

		id.addEventListener("input", () => {
			model.id = id.value;
			name.placeholder = id.value || "Model";
			syncSummary();
		});
		name.addEventListener("input", () => {
			model.name = name.value;
			syncSummary();
		});
		contextWindow.addEventListener("input", () => {
			model.contextWindow = Number(contextWindow.value);
			syncSummary();
		});
		maxTokens.addEventListener("input", () => { model.maxTokens = Number(maxTokens.value); });
		vision.addEventListener("change", () => {
			model.vision = vision.checked;
			syncSummary();
		});

		const builtinPanel = this.#builtinDataPanel(model, () => {
			name.value = model.name;
			name.placeholder = model.id || "Model";
			contextWindow.value = String(model.contextWindow);
			maxTokens.value = String(model.maxTokens);
			vision.checked = model.vision;
			for (const item of levelInputs) item.input.checked = model.thinkingLevels.includes(item.level);
			syncSummary();
		});
		const useBuiltin = h("button", {
			class: "btn small model-use-builtin", type: "button",
			onclick: () => builtinPanel.toggle(),
		}, t("settings.useBuiltinData"));
		const remove = h("button", { class: "btn danger small", type: "button", onclick: () => {
			this.#draft.models.splice(index, 1);
			this.#renderManual();
		} }, t("settings.removeModel"));
		syncSummary();
		return h("details", { class: "model-editor", open: !model.id, "data-model": model.id },
			summary,
			h("div", { class: "model-editor-grid" },
				this.#field(t("settings.modelId"), id), this.#field(t("settings.modelName"), name),
				this.#field(t("settings.contextWindow"), contextWindow), this.#field(t("settings.maxTokens"), maxTokens),
				h("label", { class: "vision-check" }, vision, t("settings.visionCapable")),
				h("div", { class: "model-thinking" }, h("span", null, t("settings.supportedThinking")),
					h("div", { class: "thinking-checks" }, ...levelInputs.map((item) => item.label))),
				h("div", { class: "model-editor-actions" }, useBuiltin, remove),
				builtinPanel.element));
	}

	#builtinDataPanel(model: ModelConfig, onApplied: () => void) {
		const panel = h("div", { class: "model-builtin-panel", hidden: true });
		const title = h("strong", { class: "provider-fetch-title" }, t("settings.useBuiltinData"));
		const back = h("button", { class: "btn small builtin-back", type: "button", hidden: true }, t("settings.backLabel"));
		const closeBtn = h("button", { class: "icon-btn small builtin-close", type: "button", "aria-label": t("settings.cancel") }, icon("x", 14));
		const search = h("input", {
			class: "input builtin-search", type: "search", autocomplete: "off", spellcheck: "false",
			placeholder: t("settings.builtinSearch"), "aria-label": t("settings.builtinSearch"),
		});
		const hint = h("p", { class: "provider-fetch-note" }, t("settings.builtinHint"));
		const candidatesEl = h("div", { class: "builtin-candidate-list" });
		const pickView = h("div", { class: "builtin-pick-view" }, search, hint, candidatesEl);

		const refLabel = h("p", { class: "builtin-ref-label" });
		const diffList = h("div", { class: "builtin-diff-list" });
		const applyBtn = h("button", { class: "btn primary small builtin-apply", type: "button" });
		const cancelBtn = h("button", { class: "btn small builtin-cancel", type: "button" }, t("settings.cancel"));
		const previewView = h("div", { class: "builtin-preview-view", hidden: true },
			refLabel, diffList, h("div", { class: "provider-fetch-actions" }, applyBtn, cancelBtn));

		panel.append(
			h("div", { class: "provider-fetch-head" }, title, h("div", { class: "builtin-head-actions" }, back, closeBtn)),
			pickView,
			previewView,
		);

		let mode: { kind: "idle" } | { kind: "pick" } | { kind: "preview"; candidate: BuiltinCandidate; changes: BuiltinFieldChange[]; checked: boolean[] } = { kind: "idle" };

		const close = () => {
			mode = { kind: "idle" };
			panel.hidden = true;
		};

		const renderCandidates = () => {
			const matches = matchBuiltinModels(this.#source()?.providers.value ?? [], search.value);
			if (matches.length === 0) {
				candidatesEl.replaceChildren(h("div", { class: "list-empty", role: "status" }, t("settings.builtinNoMatch")));
				return;
			}
			candidatesEl.replaceChildren(...matches.map((candidate) => {
				const caps = modelCapabilitiesText(candidate.model, true);
				return h("button", {
					class: "builtin-candidate-row", type: "button",
					"data-provider": candidate.providerId, "data-model": candidate.model.id,
					onclick: () => openPreview(candidate),
				},
				h("span", { class: "builtin-candidate-id" }, `${candidate.providerId} / ${candidate.model.id}`),
				candidate.model.name && candidate.model.name !== candidate.model.id
					? h("span", { class: "fetch-model-name" }, candidate.model.name) : null,
				caps ? h("span", { class: "model-capabilities" }, caps) : null);
			}));
		};

		const syncApplyButton = () => {
			if (mode.kind !== "preview") return;
			const count = mode.checked.filter(Boolean).length;
			applyBtn.disabled = count === 0;
			applyBtn.textContent = count > 0 ? t("settings.builtinApply", count) : t("settings.builtinApplyNone");
		};

		const openPreview = (candidate: BuiltinCandidate) => {
			const changes = computeBuiltinChanges(model, candidate.model, {
				formatBoolean: (value) => t(value ? "settings.builtinBool.true" : "settings.builtinBool.false"),
				formatThinkingLevel: (level) => t(`thinking.level.${level}`),
				unsetLabel: t("settings.builtinUnset"),
			});
			const checked = changes.map((change) => change.checked);
			mode = { kind: "preview", candidate, changes, checked };
			back.hidden = false;
			pickView.hidden = true;
			previewView.hidden = false;
			refLabel.textContent = t("settings.builtinReference", `${candidate.providerId} / ${candidate.model.id}`);
			diffList.replaceChildren(...changes.map((change, idx) => {
				const checkbox = h("input", {
					type: "checkbox",
					checked: checked[idx]!,
					disabled: change.same,
				});
				if (!change.same) {
					checkbox.addEventListener("change", () => {
						checked[idx] = checkbox.checked;
						syncApplyButton();
					});
				}
				return h("label", { class: "builtin-diff-row", "data-field": change.field, "data-same": String(change.same) },
					checkbox,
					h("span", { class: "builtin-diff-info" },
						h("span", { class: "builtin-diff-field" }, t(`settings.builtinField.${change.field}`)),
						h("span", { class: "builtin-diff-values" },
							change.same ? change.referenceText : `${change.currentText} → ${change.referenceText}`)),
					change.same ? h("span", { class: "pill" }, t("settings.builtinAlreadySet")) : null);
			}));
			syncApplyButton();
		};

		const openPick = (resetQuery: boolean) => {
			mode = { kind: "pick" };
			panel.hidden = false;
			back.hidden = true;
			pickView.hidden = false;
			previewView.hidden = true;
			if (resetQuery) search.value = model.id.trim();
			renderCandidates();
			search.focus({ preventScroll: true });
		};

		search.addEventListener("input", () => {
			if (mode.kind === "pick") renderCandidates();
		});
		back.addEventListener("click", () => openPick(false));
		closeBtn.addEventListener("click", close);
		cancelBtn.addEventListener("click", close);
		applyBtn.addEventListener("click", () => {
			if (mode.kind !== "preview") return;
			let applied = 0;
			for (const [idx, change] of mode.changes.entries()) {
				if (!mode.checked[idx]) continue;
				change.apply(model);
				applied++;
			}
			if (applied === 0) return;
			const refName = `${mode.candidate.providerId} / ${mode.candidate.model.id}`;
			onApplied();
			close();
			toast(t("settings.builtinApplied", applied, refName));
		});

		return {
			element: panel,
			toggle: () => {
				if (mode.kind === "idle") openPick(true);
				else close();
			},
		};
	}

	#builtinModelRow(model: ModelSummary) {
		const capabilities = [compactTokens(model.contextWindow), model.vision ? t("settings.vision") : ""].filter(Boolean).join(" · ");
		return h("div", { class: "discovered-model", "data-model": model.id },
			h("div", null, h("strong", null, model.name), model.name !== model.id ? h("span", null, model.id) : null),
			h("span", { class: "model-capabilities" }, capabilities));
	}

	#closeFetchPanel() {
		this.#fetchState = { kind: "idle" };
		this.#fetchChecked.clear();
		this.#fetchSearch.value = "";
		this.#renderFetchPanel();
	}

	#renderFetchPanel() {
		const state = this.#fetchState;
		this.#fetchPanel.hidden = state.kind === "idle";
		this.#customFetch.textContent = state.kind === "loading" ? t("settings.discovering") : t("settings.getModels");
		this.#customFetch.disabled = this.#busy || state.kind === "loading";
		if (state.kind === "idle") return;
		if (state.kind === "loading") {
			this.#fetchHeaderCount.textContent = "";
			this.#fetchStatus.hidden = false;
			this.#fetchStatus.dataset.error = "false";
			this.#fetchStatus.textContent = t("settings.discovering");
			this.#fetchBody.hidden = true;
			return;
		}
		if (state.kind === "error") {
			this.#fetchHeaderCount.textContent = "";
			this.#fetchStatus.hidden = false;
			this.#fetchStatus.dataset.error = "true";
			this.#fetchStatus.textContent = state.message;
			this.#fetchBody.hidden = true;
			return;
		}
		this.#fetchHeaderCount.textContent = t("settings.fetchCount", state.models.length);
		this.#fetchStatus.hidden = true;
		this.#fetchBody.hidden = false;
		this.#fetchTruncated.hidden = !state.truncated;
		this.#renderFetchResults();
	}

	#filteredFetchModels(): { model: ModelConfig; added: boolean }[] {
		if (this.#fetchState.kind !== "results") return [];
		const existing = new Set(this.#draft.models.map((model) => model.id.trim()).filter(Boolean));
		const query = this.#fetchSearch.value.trim().toLowerCase();
		return this.#fetchState.models
			.filter((model) => !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query))
			.map((model) => ({ model, added: existing.has(model.id) }));
	}

	#renderFetchResults() {
		if (this.#fetchState.kind !== "results") return;
		const rows = this.#filteredFetchModels();
		const selectable = rows.filter((row) => !row.added);
		const allSelected = selectable.length > 0 && selectable.every((row) => this.#fetchChecked.has(row.model.id));
		this.#fetchSelectAll.textContent = t(allSelected ? "settings.fetchClearAll" : "settings.fetchSelectAll");
		this.#fetchSelectAll.disabled = selectable.length === 0;
		this.#fetchSelected.textContent = t("settings.fetchSelected", this.#fetchChecked.size);
		this.#fetchImport.disabled = this.#fetchChecked.size === 0;
		this.#fetchImport.textContent = this.#fetchChecked.size > 0
			? t("settings.importModels", this.#fetchChecked.size)
			: t("settings.importNone");

		if (this.#fetchState.models.length === 0) {
			this.#fetchList.replaceChildren(h("div", { class: "list-empty", role: "status" }, t("settings.fetchEmpty")));
			return;
		}
		if (rows.length === 0) {
			this.#fetchList.replaceChildren(h("div", { class: "list-empty", role: "status" }, t("settings.fetchNoMatch")));
			return;
		}
		this.#fetchList.replaceChildren(...rows.map(({ model, added }) => {
			const checkbox = h("input", {
				type: "checkbox",
				checked: added || this.#fetchChecked.has(model.id),
				disabled: added,
			});
			if (!added) {
				checkbox.addEventListener("change", () => {
					if (checkbox.checked) this.#fetchChecked.add(model.id);
					else this.#fetchChecked.delete(model.id);
					this.#syncFetchSelectionState();
				});
			}
			const meta = modelCapabilitiesText(model, true);
			return h("label", { class: "fetch-model-row", "data-model": model.id, "data-added": String(added) },
				checkbox,
				h("span", { class: "fetch-model-info" },
					h("strong", null, model.id),
					model.name && model.name !== model.id ? h("span", { class: "fetch-model-name" }, model.name) : null,
					meta ? h("span", { class: "model-capabilities" }, meta) : null),
				added ? h("span", { class: "pill" }, t("settings.fetchAdded")) : null);
		}));
	}

	#syncFetchSelectionState() {
		const rows = this.#filteredFetchModels();
		const selectable = rows.filter((row) => !row.added);
		const allSelected = selectable.length > 0 && selectable.every((row) => this.#fetchChecked.has(row.model.id));
		this.#fetchSelectAll.textContent = t(allSelected ? "settings.fetchClearAll" : "settings.fetchSelectAll");
		this.#fetchSelected.textContent = t("settings.fetchSelected", this.#fetchChecked.size);
		this.#fetchImport.disabled = this.#fetchChecked.size === 0;
		this.#fetchImport.textContent = this.#fetchChecked.size > 0
			? t("settings.importModels", this.#fetchChecked.size)
			: t("settings.importNone");
	}

	#toggleFetchSelectAll() {
		const selectable = this.#filteredFetchModels().filter((row) => !row.added);
		if (selectable.length === 0) return;
		const allSelected = selectable.every((row) => this.#fetchChecked.has(row.model.id));
		for (const row of selectable) {
			if (allSelected) this.#fetchChecked.delete(row.model.id);
			else this.#fetchChecked.add(row.model.id);
		}
		this.#renderFetchResults();
	}

	#importSelectedModels() {
		if (this.#fetchState.kind !== "results" || this.#fetchChecked.size === 0) return;
		const existing = new Set(this.#draft.models.map((model) => model.id.trim()).filter(Boolean));
		let imported = 0;
		for (const model of this.#fetchState.models) {
			if (!this.#fetchChecked.has(model.id) || existing.has(model.id)) continue;
			existing.add(model.id);
			this.#draft.models.push({ ...model, thinkingLevels: [...model.thinkingLevels] });
			imported++;
		}
		this.#closeFetchPanel();
		this.#renderManual();
		if (imported > 0) toast(t("settings.importedModels", imported));
	}

	async #probeCustomModels() {
		if (this.#busy || this.#fetchState.kind === "loading") return;
		const rawUrl = this.#baseUrl.value.trim();
		if (!rawUrl) return void toast(t("settings.endpointRequired"), "error");
		const baseUrl = validEndpointUrl(rawUrl);
		if (!baseUrl) return void toast(t("settings.endpointInvalid"), "error");
		const asked = requestModelAccess(baseUrl);
		this.#fetchState = { kind: "loading" };
		this.#fetchChecked.clear();
		this.#fetchSearch.value = "";
		this.#renderFetchPanel();
		try {
			if (!await asked) {
				this.#closeFetchPanel();
				throw new Error(t("settings.permissionDenied"));
			}
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			const key = this.#key.value.trim();
			const result = await source.probeModels({
				...(this.#summary() ? { provider: this.#id } : {}),
				baseUrl,
				api: this.#draft.api,
				...(key ? { key } : {}),
			}, context);
			if (this.#closed) return;
			this.#fetchState = { kind: "results", models: result.models, truncated: result.truncated };
			this.#renderFetchPanel();
			this.#fetchSearch.focus({ preventScroll: true });
		} catch (error) {
			if (this.#closed) return;
			const message = error instanceof Error ? error.message : String(error);
			if (this.#fetchState.kind === "loading") {
				this.#fetchState = { kind: "error", message };
				this.#renderFetchPanel();
			} else {
				toastError(error);
			}
		}
	}

	async #saveProvider() {
		if (this.#busy) return;
		if (this.#kind === "custom") {
			await this.#saveCustom();
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

	async #discoverBuiltinModels() {
		if (this.#busy || this.#kind !== "builtin") return;
		const provider = this.#currentSummary();
		if (!provider) return;
		this.#setBusy(true, this.#builtinRefresh);
		try {
			await this.#source()?.refreshProvider({ provider: provider.id }, context);
		} catch (error) {
			toastError(error);
		} finally {
			this.#setBusy(false, this.#builtinRefresh);
		}
	}

	async #saveCustom() {
		const key = this.#key.value.trim();
		const profile: ProviderProfile = {
			...this.#draft,
			name: this.#draft.name.trim(), baseUrl: this.#draft.baseUrl.trim(),
			models: this.#draft.models.map((model) => ({
				...model,
				id: model.id.trim(),
				name: model.name.trim() || model.id.trim(),
				thinkingLevels: model.thinkingLevels.length ? model.thinkingLevels : ["off"],
			})),
		};
		if (!profile.name || !profile.baseUrl || profile.models.some((model) => !model.id)) {
			toast(t("settings.completeFields"), "error");
			return false;
		}
		if (!this.#summary()?.configured && !key) {
			toast(t("settings.keyRequired"), "error");
			return false;
		}
		const asked = requestModelAccess(profile.baseUrl);
		this.#setBusy(true, this.#save);
		try {
			if (!await asked) throw new Error(t("settings.permissionDenied"));
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			await source.saveProvider({ profile, ...(key ? { key } : {}) }, context);
			this.#kindLocked = true;
			this.#key.value = "";
			toast(t("settings.providerSaved"));
			this.#onClose();
			return true;
		} catch (error) {
			toastError(error);
			return false;
		} finally {
			this.#setBusy(false, this.#save);
		}
	}

	async #removeProvider() {
		const provider = this.#currentSummary();
		if (!provider || this.#busy) return;
		if (this.#kind === "custom" && !this.#deleteConfirm.armed) return this.#deleteConfirm.arm();
		this.#setBusy(true, this.#delete);
		try {
			const source = this.#source();
			if (!source) throw new Error("The workspace is not ready.");
			if (this.#kind === "builtin") await source.removeCredential({ provider: provider.id }, context);
			else await source.deleteProvider({ provider: provider.id }, context);
			toast(t("settings.providerDeleted"));
			this.#onClose();
		} catch (error) {
			toastError(error);
			this.#deleteConfirm.reset();
		} finally {
			this.#setBusy(false, this.#delete);
		}
	}

	#setBusy(busy: boolean, button?: HTMLButtonElement) {
		this.#busy = busy;
		this.element.dataset.busy = String(busy);
		this.#save.disabled = busy || (this.#kind === "builtin" && !this.#builtinId);
		this.#builtinRefresh.disabled = busy || this.#currentSummary()?.refreshing === true;
		this.#customFetch.disabled = busy || this.#fetchState.kind === "loading";
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
		// Only built-in providers expose their catalog directly here; custom providers curate their own model list.
		this.#discoverySection.hidden = !builtin || !summary?.configured;
		const statusText = summary?.refreshing ? t("settings.discovering") : summary?.discoveryError ?? "";
		this.#status.hidden = !statusText;
		this.#status.textContent = statusText;
		this.#status.dataset.error = String(Boolean(!summary?.refreshing && summary?.discoveryError));
		this.#discovered.replaceChildren(...(summary?.models.length
			? summary.models.map((model) => this.#builtinModelRow(model))
			: [h("div", { class: "list-empty" }, t("settings.noDiscoveredModels"))]));
		this.#builtinRefresh.textContent = summary?.refreshing ? t("settings.discovering") : t("settings.getModels");
		this.#builtinRefresh.disabled = this.#busy || summary?.refreshing === true;
		this.#updateKeyPlaceholder();
		this.#updateDeleteVisibility();
	}

	close() {
		this.#closed = true;
		this.#deleteConfirm.reset();
		this.#key.value = "";
	}
}
