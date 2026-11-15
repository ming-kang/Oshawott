import { computed, defineComponent, nextTick, reactive, shallowRef, watch, type PropType } from "vue";
import type { ModelApi, ModelConfig, ProviderProfile } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { Icon, Segmented, useConfirmation } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { t } from "./i18n/index.ts";
import { LoginCard } from "./login-card.tsx";
import { requestModelAccess } from "./model-permissions.ts";
import { DiscoveredModel, ModelEditor } from "./provider-models.tsx";
import { baseUrlPlaceholder, connectionNote, defaultModel, modelCapabilitiesText, providerRank, validEndpointUrl } from "./provider-utils.ts";
import { toast, toastError } from "./ui.ts";

type ProviderKind = "builtin" | "custom";
type FetchState = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "results"; models: ModelConfig[]; truncated: boolean };
const context = BACKGROUND_CONTEXT;

export const ProviderEditorSheet = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true }, provider: String },
	setup(props) {
		const { controller } = props;
		const id = props.provider ?? `custom-${crypto.randomUUID()}`;
		const existing = props.provider ? controller.store.providers.value.find((provider) => provider.id === props.provider) : undefined;
		const kind = shallowRef<ProviderKind>(existing?.kind ?? "builtin");
		const kindLocked = shallowRef(props.provider !== undefined);
		const pendingLogin = props.provider ? undefined : controller.store.logins.value.find((login) => login.status === "pending");
		const builtinId = shallowRef(existing?.kind === "builtin" ? existing.id : pendingLogin?.provider ?? "");
		const busyAction = shallowRef<"save" | "refresh" | "delete" | "fetch">();
		const busy = computed(() => busyAction.value !== undefined);
		const key = shallowRef("");
		const search = shallowRef("");
		const searchInput = shallowRef<HTMLInputElement>();
		const keyInput = shallowRef<HTMLInputElement>();
		const activeOption = shallowRef(0);
		const fetchState = shallowRef<FetchState>({ kind: "idle" });
		const fetchChecked = shallowRef<ReadonlySet<string>>(new Set());
		const fetchSearch = shallowRef("");
		const removeConfirmation = useConfirmation();
		const draft = reactive<ProviderProfile>({
			id, name: existing?.name ?? "", baseUrl: existing?.baseUrl ?? "", api: existing?.api ?? "openai-responses",
			models: existing?.models.map((model) => ({ ...model, thinkingLevels: [...model.thinkingLevels] })) ?? [],
		});
		const modelKeys = new WeakMap<object, string>();
		const modelKey = (model: ModelConfig) => {
			let key = modelKeys.get(model);
			if (!key) { key = crypto.randomUUID(); modelKeys.set(model, key); }
			return key;
		};
		const summary = (providerId = id) => controller.store.providers.value.find((provider) => provider.id === providerId);
		const currentSummary = computed(() => kind.value === "builtin" ? summary(builtinId.value) : summary());
		const loginSession = computed(() => currentSummary.value && controller.store.logins.value.find((login) => login.provider === currentSummary.value!.id));
		const offered = computed(() => {
			const pinned = kindLocked.value || loginSession.value !== undefined;
			return controller.store.providers.value.filter((provider) => provider.kind === "builtin" && (pinned ? provider.id === builtinId.value : !provider.configured));
		});
		const chosen = computed(() => offered.value.find((provider) => provider.id === builtinId.value));
		const pickerProviders = computed(() => offered.value
			.filter((provider) => !search.value.trim() || `${provider.name} ${provider.id}`.toLowerCase().includes(search.value.trim().toLowerCase()))
			.sort((a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name)));
		watch(chosen, (value) => { if (!value) builtinId.value = ""; });
		watch(pickerProviders, () => { activeOption.value = 0; });
		const endpoint = computed(() => connectionNote(draft.api, draft.baseUrl));
		const keyFieldHidden = computed(() => kind.value === "builtin" && (!currentSummary.value || currentSummary.value.apiKey === false));
		const filteredFetch = computed(() => {
			if (fetchState.value.kind !== "results") return [];
			const existing = new Set(draft.models.map((model) => model.id.trim()).filter(Boolean));
			const query = fetchSearch.value.trim().toLowerCase();
			return fetchState.value.models.filter((model) => !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query))
				.map((model) => ({ model, added: existing.has(model.id) }));
		});
		const selectableFetch = computed(() => filteredFetch.value.filter((row) => !row.added));
		const allFetchSelected = computed(() => selectableFetch.value.length > 0 && selectableFetch.value.every((row) => fetchChecked.value.has(row.model.id)));

		const pick = async (providerId: string) => {
			if (busy.value) return;
			builtinId.value = providerId;
			key.value = "";
			search.value = "";
			await nextTick();
			(keyFieldHidden.value ? document.querySelector<HTMLElement>("#provider-login button") : keyInput.value)?.focus({ preventScroll: true });
		};
		const closeFetch = () => {
			fetchState.value = { kind: "idle" };
			fetchChecked.value = new Set();
			fetchSearch.value = "";
		};
		const importSelected = () => {
			if (fetchState.value.kind !== "results" || !fetchChecked.value.size) return;
			const existing = new Set(draft.models.map((model) => model.id.trim()).filter(Boolean));
			let imported = 0;
			for (const model of fetchState.value.models) {
				if (!fetchChecked.value.has(model.id) || existing.has(model.id)) continue;
				existing.add(model.id);
				draft.models.push({ ...model, thinkingLevels: [...model.thinkingLevels] });
				imported++;
			}
			closeFetch();
			if (imported) toast(t("settings.importedModels", imported));
		};
		const probeCustomModels = async () => {
			if (busy.value || fetchState.value.kind === "loading") return;
			const rawUrl = draft.baseUrl.trim();
			if (!rawUrl) return toast(t("settings.endpointRequired"), "error");
			const baseUrl = validEndpointUrl(rawUrl);
			if (!baseUrl) return toast(t("settings.endpointInvalid"), "error");
			const asked = requestModelAccess(baseUrl);
			busyAction.value = "fetch";
			fetchState.value = { kind: "loading" };
			fetchChecked.value = new Set();
			fetchSearch.value = "";
			try {
				if (!await asked) { closeFetch(); throw new Error(t("settings.permissionDenied")); }
				const source = controller.workspace;
				if (!source) throw new Error("The workspace is not ready.");
				const result = await source.probeModels({
					...(summary() ? { provider: id } : {}), baseUrl, api: draft.api, ...(key.value.trim() ? { key: key.value.trim() } : {}),
				}, context);
				fetchState.value = { kind: "results", models: result.models, truncated: result.truncated };
				await nextTick();
				document.querySelector<HTMLInputElement>("#provider-fetch-search")?.focus({ preventScroll: true });
			} catch (error) {
				if (fetchState.value.kind === "loading") fetchState.value = { kind: "error", message: error instanceof Error ? error.message : String(error) };
				else toastError(error);
			} finally { busyAction.value = undefined; }
		};
		const saveCustom = async () => {
			const profile: ProviderProfile = {
				id: draft.id, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), api: draft.api,
				models: draft.models.map((model) => ({
					id: model.id.trim(), name: model.name.trim() || model.id.trim(), contextWindow: model.contextWindow, maxTokens: model.maxTokens,
					vision: model.vision, thinkingLevels: model.thinkingLevels.length ? [...model.thinkingLevels] : ["off"],
				})),
			};
			if (!profile.name || !profile.baseUrl || profile.models.some((model) => !model.id)) { toast(t("settings.completeFields"), "error"); return false; }
			if (!summary()?.configured && !key.value.trim()) { toast(t("settings.keyRequired"), "error"); return false; }
			const asked = requestModelAccess(profile.baseUrl);
			busyAction.value = "save";
			try {
				if (!await asked) throw new Error(t("settings.permissionDenied"));
				const source = controller.workspace;
				if (!source) throw new Error("The workspace is not ready.");
				await source.saveProvider({ profile, ...(key.value.trim() ? { key: key.value.trim() } : {}) }, context);
				kindLocked.value = true;
				key.value = "";
				toast(t("settings.providerSaved"));
				controller.openSettings();
				return true;
			} catch (error) { toastError(error); return false; } finally { busyAction.value = undefined; }
		};
		const save = async () => {
			if (busy.value) return;
			if (kind.value === "custom") return void await saveCustom();
			const provider = currentSummary.value;
			if (!provider) return toast(t("settings.noBuiltinProviders"), "error");
			if (!key.value.trim()) {
				if (provider.configured) controller.openSettings();
				else toast(t("settings.keyRequired"), "error");
				return;
			}
			const asked = requestModelAccess(provider.baseUrl);
			busyAction.value = "save";
			try {
				if (!await asked) throw new Error(t("settings.permissionDenied"));
				const source = controller.workspace;
				if (!source) throw new Error("The workspace is not ready.");
				await source.setApiKey({ provider: provider.id, key: key.value.trim() }, context);
				key.value = "";
				toast(t("settings.providerSaved"));
				controller.openSettings();
			} catch (error) { toastError(error); } finally { busyAction.value = undefined; }
		};
		const discover = async () => {
			const provider = currentSummary.value;
			if (!provider || busy.value || kind.value !== "builtin") return;
			busyAction.value = "refresh";
			try { await controller.workspace?.refreshProvider({ provider: provider.id }, context); } catch (error) { toastError(error); } finally { busyAction.value = undefined; }
		};
		const remove = async () => {
			const provider = currentSummary.value;
			if (!provider || busy.value) return;
			if (kind.value === "custom" && !removeConfirmation.armed.value) return removeConfirmation.arm();
			busyAction.value = "delete";
			try {
				const source = controller.workspace;
				if (!source) throw new Error("The workspace is not ready.");
				if (kind.value === "builtin") await source.removeCredential({ provider: provider.id }, context);
				else await source.deleteProvider({ provider: provider.id }, context);
				toast(t("settings.providerDeleted"));
				controller.openSettings();
			} catch (error) { toastError(error); removeConfirmation.reset(); } finally { busyAction.value = undefined; }
		};
		const Field = defineComponent({
			props: { label: { type: String, required: true } },
			setup(fieldProps, { slots }) {
				return () => <label class="provider-field"><span>{fieldProps.label}</span>{slots.default?.()}</label>;
			},
		});

		return () => (
			<section class="sheet" id="provider-editor" role="dialog" aria-modal="true" aria-label={t("settings.providerEditor")} data-busy={String(busy.value)}>
				<div class="panel-head">
					<button class="icon-btn" id="provider-back" type="button" aria-label={t("settings.back")} onClick={() => controller.openSettings()}><Icon name="back" size={18} /></button>
					<span class="panel-title">{t(kindLocked.value ? "settings.editProvider" : "settings.addProvider")}</span>
				</div>
				<div class="sheet-body">
					{!kindLocked.value && <section class="section" id="provider-type-section"><h3>{t("settings.providerType")}</h3>
						<Segmented id="provider-kind" label={t("settings.providerType")} selected={kind.value} disabled={busy.value || kindLocked.value}
							options={[{ value: "builtin" as ProviderKind, label: t("settings.providerType.builtin"), id: "provider-kind-builtin" }, { value: "custom" as ProviderKind, label: t("settings.providerType.custom"), id: "provider-kind-custom" }]}
							onChoose={(value) => { if (!kindLocked.value && !busy.value) { kind.value = value; removeConfirmation.reset(); } }} /></section>}
					<section class="section"><h3>{t("settings.providerEditor")}</h3><div class="card provider-editor-form">
						{kind.value === "builtin" ? (
							<div class="provider-field" id="builtin-provider-field"><span>{t("settings.builtinProvider")}</span>
								{chosen.value ? <div class="provider-chosen" id="builtin-provider-chosen" data-provider={chosen.value.id}>
									<span class="provider-chosen-name">{chosen.value.name}</span>{chosen.value.oauth && <span class="pill" data-on="true">{t("settings.signInBadge")}</span>}
									{!kindLocked.value && (loginSession.value === undefined || loginSession.value.status === "failed") && <button class="btn small" id="builtin-provider-change" type="button" disabled={busy.value}
										onClick={() => { builtinId.value = ""; key.value = ""; void nextTick(() => searchInput.value?.focus({ preventScroll: true })); }}>{t("settings.changeProvider")}</button>}
								</div> : (
									<div class="provider-picker">
										{offered.value.length > 0 && <input class="input" id="builtin-provider-search" type="search" autocomplete="off" spellcheck="false"
											placeholder={t("settings.searchProviders")} aria-label={t("settings.searchProviders")} role="combobox" aria-autocomplete="list"
											aria-expanded="true" aria-controls="builtin-provider-list" aria-activedescendant={pickerProviders.value.length ? `builtin-provider-option-${activeOption.value}` : undefined}
											value={search.value} disabled={busy.value} ref={searchInput}
											onInput={(event) => { search.value = (event.target as HTMLInputElement).value; }}
											onKeydown={(event) => {
												if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); activeOption.value = Math.max(0, Math.min(activeOption.value + (event.key === "ArrowDown" ? 1 : -1), pickerProviders.value.length - 1)); }
												else if (event.key === "Home" || event.key === "End") { event.preventDefault(); activeOption.value = event.key === "Home" ? 0 : pickerProviders.value.length - 1; }
												else if (event.key === "Enter") { event.preventDefault(); const provider = pickerProviders.value[activeOption.value]; if (provider) void pick(provider.id); }
											}} />}
										<div class="menu-list provider-list" id="builtin-provider-list" role="listbox" aria-label={t("settings.builtinProvider")}>
											{pickerProviders.value.length ? pickerProviders.value.map((provider, index) => (
												<button class={{ "menu-item provider-option": true, active: activeOption.value === index }} id={`builtin-provider-option-${index}`} type="button" role="option"
													tabindex={-1} aria-selected="false" data-provider={provider.id} onClick={() => void pick(provider.id)}>
													<span class="menu-item-name">{provider.name}{!provider.apiKey && <span class="menu-item-details">{t("settings.signInOnly")}</span>}</span>
													{provider.oauth && <span class="pill" data-on="true">{t("settings.signInBadge")}</span>}
												</button>
											)) : <div class="list-empty" role="status">{t(search.value ? "settings.noProviderMatch" : "settings.noBuiltinProviders")}</div>}
										</div>
									</div>
								)}
							</div>
						) : (
							<>
								<Field label={t("settings.providerName")}><input class="input" id="provider-name" autocomplete="off" value={draft.name}
									onInput={(event) => { draft.name = (event.target as HTMLInputElement).value; }} /></Field>
								<div class="provider-field-group"><Field label={t("settings.providerEndpoint")}><input class="input" id="provider-base-url" placeholder={baseUrlPlaceholder(draft.api)}
									autocomplete="off" spellcheck="false" value={draft.baseUrl} onInput={(event) => { draft.baseUrl = (event.target as HTMLInputElement).value; }} /></Field>
									{endpoint.value && <span class="provider-field-note" id="provider-endpoint-hint" data-warning={String(endpoint.value.warning)}>{endpoint.value.text}</span>}</div>
								<Field label={t("settings.providerApi")}><select class="input" id="provider-api" value={draft.api} onChange={(event) => { draft.api = (event.target as HTMLSelectElement).value as ModelApi; }}>
									<option value="openai-responses">OpenAI Responses</option><option value="openai-completions">OpenAI Chat Completions</option><option value="anthropic-messages">Anthropic Messages</option>
								</select></Field>
							</>
						)}
						{!keyFieldHidden.value && <Field label="API Key"><input class="input" id="provider-key" type="password" autocomplete="off" spellcheck="false"
							placeholder={currentSummary.value?.configured ? t("settings.keepKey") : t("settings.keyPlaceholder")} value={key.value} ref={keyInput}
							onInput={(event) => { key.value = (event.target as HTMLInputElement).value; }} /></Field>}
						{kind.value === "builtin" && <LoginCard controller={controller} provider={currentSummary.value} onSignedIn={() => { kindLocked.value = true; }} />}
					</div></section>
					{kind.value === "builtin" && currentSummary.value?.configured && <section class="section" id="provider-discovery">
						<div class="section-heading"><h3>{t("settings.discoveredModels")}</h3><button class="btn small" id="builtin-provider-refresh" type="button"
							disabled={busy.value || currentSummary.value.refreshing} onClick={() => void discover()}>
							{busyAction.value === "refresh" && <span class="spinner" />}{t(currentSummary.value.refreshing ? "settings.discovering" : "settings.getModels")}</button></div>
						<div class="provider-models" id="provider-discovered-models">{currentSummary.value.models.length ? currentSummary.value.models.map((model) => <DiscoveredModel model={model} key={model.id} />) : <div class="list-empty">{t("settings.noDiscoveredModels")}</div>}</div>
						{(currentSummary.value.refreshing || currentSummary.value.discoveryError) && <p class="provider-status" id="provider-discovery-status" role="status" data-error={String(!currentSummary.value.refreshing && Boolean(currentSummary.value.discoveryError))}>
							{currentSummary.value.refreshing ? t("settings.discovering") : currentSummary.value.discoveryError}</p>}
					</section>}
					{kind.value === "custom" && <section class="section" id="provider-custom-models">
						<div class="section-heading"><h3>{t("settings.models")}</h3><div class="section-heading-actions">
							<button class="btn small" id="provider-refresh" type="button" disabled={busy.value} onClick={() => void probeCustomModels()}>{t(fetchState.value.kind === "loading" ? "settings.discovering" : "settings.getModels")}</button>
							<button class="btn small" id="provider-add-model" type="button" onClick={() => {
								draft.models.push(defaultModel());
								void nextTick(() => document.querySelector<HTMLInputElement>("#provider-manual-models details:last-child input")?.focus());
							}}><Icon name="plus" size={14} />{t("settings.addModel")}</button>
						</div></div>
						{fetchState.value.kind !== "idle" && <div class="card provider-fetch-panel" id="provider-fetch-panel">
							<div class="provider-fetch-head"><div class="provider-fetch-title-row"><strong class="provider-fetch-title">{t("settings.fetchTitle")}</strong>
								<span class="provider-fetch-count">{fetchState.value.kind === "results" ? t("settings.fetchCount", fetchState.value.models.length) : ""}</span></div>
								<button class="icon-btn small" id="provider-fetch-close" type="button" aria-label={t("settings.cancel")} onClick={closeFetch}><Icon name="x" size={14} /></button></div>
							{fetchState.value.kind === "loading" || fetchState.value.kind === "error" ? <p class="provider-status" id="provider-fetch-status" role="status" data-error={String(fetchState.value.kind === "error")}>
								{fetchState.value.kind === "loading" ? t("settings.discovering") : fetchState.value.message}</p> : (
								<div class="provider-fetch-body">
									<input class="input" id="provider-fetch-search" type="search" autocomplete="off" spellcheck="false" placeholder={t("settings.fetchSearch")}
										aria-label={t("settings.fetchSearch")} value={fetchSearch.value} onInput={(event) => { fetchSearch.value = (event.target as HTMLInputElement).value; }} />
									<div class="provider-fetch-toolbar"><button class="btn small" id="provider-fetch-select-all" type="button" disabled={!selectableFetch.value.length}
										onClick={() => {
											const next = new Set(fetchChecked.value);
											for (const row of selectableFetch.value) { if (allFetchSelected.value) next.delete(row.model.id); else next.add(row.model.id); }
											fetchChecked.value = next;
										}}>{t(allFetchSelected.value ? "settings.fetchClearAll" : "settings.fetchSelectAll")}</button>
										<span class="provider-fetch-selected">{t("settings.fetchSelected", fetchChecked.value.size)}</span></div>
									<div class="provider-fetch-list" id="provider-fetch-list" role="group" aria-label={t("settings.fetchTitle")}>
										{fetchState.value.models.length === 0 ? <div class="list-empty" role="status">{t("settings.fetchEmpty")}</div>
											: filteredFetch.value.length === 0 ? <div class="list-empty" role="status">{t("settings.fetchNoMatch")}</div>
												: filteredFetch.value.map(({ model, added }) => <label class="fetch-model-row" data-model={model.id} data-added={String(added)} key={model.id}>
													<input type="checkbox" checked={added || fetchChecked.value.has(model.id)} disabled={added} onChange={(event) => {
														const next = new Set(fetchChecked.value);
														if ((event.target as HTMLInputElement).checked) next.add(model.id); else next.delete(model.id);
														fetchChecked.value = next;
													}} />
													<span class="fetch-model-info"><strong>{model.id}</strong>{model.name && model.name !== model.id && <span class="fetch-model-name">{model.name}</span>}
														<span class="model-capabilities">{modelCapabilitiesText(model, true)}</span></span>{added && <span class="pill">{t("settings.fetchAdded")}</span>}
												</label>)}
									</div>
									{fetchState.value.truncated && <p class="provider-fetch-note">{t("settings.fetchTruncated")}</p>}
									<div class="provider-fetch-actions"><button class="btn primary small" id="provider-import-models" type="button" disabled={!fetchChecked.value.size} onClick={importSelected}>
										{fetchChecked.value.size ? t("settings.importModels", fetchChecked.value.size) : t("settings.importNone")}</button>
										<button class="btn small" id="provider-fetch-cancel" type="button" onClick={closeFetch}>{t("settings.cancel")}</button></div>
								</div>
							)}
						</div>}
						<div class="provider-models" id="provider-manual-models">{draft.models.length ? draft.models.map((model, index) => (
							<ModelEditor model={model} providers={controller.store.providers.value} remove={() => draft.models.splice(index, 1)} key={modelKey(model)} />
						)) : <div class="list-empty">{t("settings.noModels")}</div>}</div>
					</section>}
					<section class="section provider-footer"><div class="provider-actions">
						{!keyFieldHidden.value && <button class="btn primary" id="provider-save" type="button" disabled={busy.value || (kind.value === "builtin" && !builtinId.value)} onClick={() => void save()}>
							{busyAction.value === "save" && <span class="spinner" />}{t("settings.save")}</button>}
						{currentSummary.value && (kind.value === "custom" || currentSummary.value.configured) && <button class="btn danger" id="provider-delete" type="button"
							data-confirm={removeConfirmation.armed.value ? "" : undefined} disabled={busy.value} onClick={() => void remove()}>
							{busyAction.value === "delete" && <span class="spinner" />}{t(removeConfirmation.armed.value ? "settings.confirmDelete" : "settings.deleteProvider")}</button>}
					</div></section>
				</div>
			</section>
		);
	},
});
