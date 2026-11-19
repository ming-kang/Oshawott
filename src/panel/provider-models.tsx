import { computed, defineComponent, onMounted, shallowRef, type PropType } from "vue";
import { THINKING_LEVELS, type ModelConfig, type ProviderSummary } from "../contracts/chat.ts";
import { type BuiltinCandidate, type BuiltinFieldChange, computeBuiltinChanges, matchBuiltinModels } from "./builtin-match.ts";
import { Icon } from "./components.tsx";
import { t } from "./i18n/index.ts";
import { compactTokens } from "./models.ts";
import { modelCapabilitiesText } from "./provider-utils.ts";
import { toast } from "./ui.ts";

export const Field = defineComponent({
	props: { label: { type: String, required: true } },
	setup(props, { slots }) {
		return () => <label class="provider-field"><span>{props.label}</span>{slots.default?.()}</label>;
	},
});

const BuiltinDataPanel = defineComponent({
	props: {
		model: { type: Object as PropType<ModelConfig>, required: true },
		providers: { type: Array as PropType<readonly ProviderSummary[]>, required: true },
	},
	setup(props) {
		const open = shallowRef(true);
		const query = shallowRef(props.model.id.trim());
		const search = shallowRef<HTMLInputElement>();
		onMounted(() => search.value?.focus({ preventScroll: true }));
		const preview = shallowRef<{ candidate: BuiltinCandidate; changes: BuiltinFieldChange[]; checked: boolean[] }>();
		const candidates = computed(() => matchBuiltinModels(props.providers, query.value));
		const selectedCount = computed(() => preview.value?.checked.filter(Boolean).length ?? 0);
		const choose = (candidate: BuiltinCandidate) => {
			const changes = computeBuiltinChanges(props.model, candidate.model, {
				formatBoolean: (value) => t(value ? "settings.builtinBool.true" : "settings.builtinBool.false"),
				formatThinkingLevel: (level) => t(`thinking.level.${level}`), unsetLabel: t("settings.builtinUnset"),
			});
			preview.value = { candidate, changes, checked: changes.map((change) => change.checked) };
		};
		const apply = () => {
			const current = preview.value;
			if (!current) return;
			let applied = 0;
			for (const [index, change] of current.changes.entries()) {
				if (!current.checked[index]) continue;
				change.apply(props.model);
				applied++;
			}
			if (!applied) return;
			const refName = `${current.candidate.providerId} / ${current.candidate.model.id}`;
			open.value = false;
			preview.value = undefined;
			toast(t("settings.builtinApplied", applied, refName));
		};
		return () => (
			<div class="model-builtin-panel" hidden={!open.value}>
				<div class="provider-fetch-head"><strong class="provider-fetch-title">{t("settings.useBuiltinData")}</strong>
					<div class="builtin-head-actions">
						{preview.value && <button class="btn small builtin-back" type="button" onClick={() => { preview.value = undefined; }}>{t("settings.backLabel")}</button>}
						<button class="icon-btn small builtin-close" type="button" aria-label={t("settings.cancel")} onClick={() => { open.value = false; preview.value = undefined; }}><Icon name="x" size={14} /></button>
					</div></div>
				{!preview.value ? (
					<div class="builtin-pick-view">
						<input class="input builtin-search" type="search" autocomplete="off" spellcheck="false" placeholder={t("settings.builtinSearch")}
							aria-label={t("settings.builtinSearch")} value={query.value} ref={search} onInput={(event) => { query.value = (event.target as HTMLInputElement).value; }} />
						<p class="provider-fetch-note">{t("settings.builtinHint")}</p>
						<div class="builtin-candidate-list">
							{candidates.value.length ? candidates.value.map((candidate) => (
								<button class="builtin-candidate-row" type="button" data-provider={candidate.providerId} data-model={candidate.model.id} onClick={() => choose(candidate)}>
									<span class="builtin-candidate-id">{candidate.providerId} / {candidate.model.id}</span>
									{candidate.model.name && candidate.model.name !== candidate.model.id && <span class="fetch-model-name">{candidate.model.name}</span>}
									<span class="model-capabilities">{modelCapabilitiesText(candidate.model, true)}</span>
								</button>
							)) : <div class="list-empty" role="status">{t("settings.builtinNoMatch")}</div>}
						</div>
					</div>
				) : (
					<div class="builtin-preview-view">
						<p class="builtin-ref-label">{t("settings.builtinReference", `${preview.value.candidate.providerId} / ${preview.value.candidate.model.id}`)}</p>
						<div class="builtin-diff-list">
							{preview.value.changes.map((change, index) => (
								<label class="builtin-diff-row" data-field={change.field} data-same={String(change.same)}>
									<input type="checkbox" checked={preview.value!.checked[index]} disabled={change.same}
										onChange={(event) => { preview.value!.checked[index] = (event.target as HTMLInputElement).checked; preview.value = { ...preview.value! }; }} />
									<span class="builtin-diff-info"><span class="builtin-diff-field">{t(`settings.builtinField.${change.field}`)}</span>
										<span class="builtin-diff-values">{change.same ? change.referenceText : `${change.currentText} → ${change.referenceText}`}</span></span>
									{change.same && <span class="pill">{t("settings.builtinAlreadySet")}</span>}
								</label>
							))}
						</div>
						<div class="provider-fetch-actions">
							<button class="btn primary small builtin-apply" type="button" disabled={!selectedCount.value} onClick={apply}>
								{selectedCount.value ? t("settings.builtinApply", selectedCount.value) : t("settings.builtinApplyNone")}</button>
							<button class="btn small builtin-cancel" type="button" onClick={() => { open.value = false; preview.value = undefined; }}>{t("settings.cancel")}</button>
						</div>
					</div>
				)}
			</div>
		);
	},
});

export const ModelEditor = defineComponent({
	props: {
		model: { type: Object as PropType<ModelConfig>, required: true },
		providers: { type: Array as PropType<readonly ProviderSummary[]>, required: true },
		remove: { type: Function as PropType<() => void>, required: true },
		/** The model ID is missing and a save was refused for it. */
		invalid: Boolean,
	},
	setup(props) {
		const expanded = shallowRef(!props.model.id);
		const builtinOpen = shallowRef(false);
		const builtinKey = shallowRef(0);
		const title = computed(() => props.model.name.trim() || props.model.id.trim() || t("settings.newModel"));
		const subtitle = computed(() => {
			const id = props.model.id.trim();
			const name = props.model.name.trim();
			return [id && name && name !== id ? id : "", modelCapabilitiesText(props.model)].filter(Boolean).join(" · ");
		});
		return () => (
			<details class="model-editor" open={expanded.value} data-model={props.model.id} onToggle={(event) => { expanded.value = (event.target as HTMLDetailsElement).open; }}>
				<summary class="model-editor-summary"><strong class="model-editor-title">{title.value}</strong><span class="model-editor-meta">{subtitle.value}</span></summary>
				<div class="model-editor-grid">
					<Field label={t("settings.modelId")}><input class="input" value={props.model.id} placeholder="model-id" aria-label={t("settings.modelId")} aria-invalid={props.invalid}
						onInput={(event) => { props.model.id = (event.target as HTMLInputElement).value; }} /></Field>
					<Field label={t("settings.modelName")}><input class="input" value={props.model.name} placeholder={props.model.id || "Model"} aria-label={t("settings.modelName")}
						onInput={(event) => { props.model.name = (event.target as HTMLInputElement).value; }} /></Field>
					<Field label={t("settings.contextWindow")}><input class="input" type="number" min={1} step={1} value={props.model.contextWindow} aria-label={t("settings.contextWindow")}
						onInput={(event) => { props.model.contextWindow = Number((event.target as HTMLInputElement).value); }} /></Field>
					<Field label={t("settings.maxTokens")}><input class="input" type="number" min={1} step={1} value={props.model.maxTokens} aria-label={t("settings.maxTokens")}
						onInput={(event) => { props.model.maxTokens = Number((event.target as HTMLInputElement).value); }} /></Field>
					<label class="vision-check"><input type="checkbox" checked={props.model.vision} onChange={(event) => { props.model.vision = (event.target as HTMLInputElement).checked; }} />{t("settings.visionCapable")}</label>
					<div class="model-thinking"><span>{t("settings.supportedThinking")}</span><div class="thinking-checks">
						{THINKING_LEVELS.map((level) => <label><input type="checkbox" checked={props.model.thinkingLevels.includes(level)} onChange={(event) => {
							const checked = (event.target as HTMLInputElement).checked;
							props.model.thinkingLevels = checked ? THINKING_LEVELS.filter((item) => item === level || props.model.thinkingLevels.includes(item))
								: props.model.thinkingLevels.filter((item) => item !== level);
						}} />{t(`thinking.level.${level}`)}</label>)}
					</div></div>
					<div class="model-editor-actions">
						<button class="btn small model-use-builtin" type="button" onClick={() => { builtinOpen.value = !builtinOpen.value; builtinKey.value++; }}>{t("settings.useBuiltinData")}</button>
						<button class="btn danger small" type="button" onClick={props.remove}>{t("settings.removeModel")}</button>
					</div>
					{builtinOpen.value && <BuiltinDataPanel model={props.model} providers={props.providers} key={builtinKey.value} />}
				</div>
			</details>
		);
	},
});

export const DiscoveredModel = ({ model }: { model: ProviderSummary["models"][number] }) => (
	<div class="discovered-model" data-model={model.id}>
		<div><strong>{model.name}</strong>{model.name !== model.id && <span>{model.id}</span>}</div>
		<span class="model-capabilities">{[compactTokens(model.contextWindow), model.vision ? t("settings.vision") : ""].filter(Boolean).join(" · ")}</span>
	</div>
);
