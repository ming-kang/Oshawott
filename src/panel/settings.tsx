import { computed, defineComponent, shallowRef, watch, type PropType } from "vue";
import { type BusyMode, type Preference } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { ext } from "../platform/webext.ts";
import { Icon, Logo, Segmented, useConfirmation } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { saveLanguage, savedLanguagePreference, t, type LanguagePreference } from "./i18n/index.ts";
import { toast, toastError } from "./ui.ts";

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

export const SettingsSheet = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const { controller } = props;
		const theme = shallowRef<Theme>(savedTheme());
		const deliveryPending = shallowRef(false);
		const preferencePending = shallowRef(false);
		const instructionsPending = shallowRef(false);
		const instructionsDirty = shallowRef(false);
		const instructionsDraft = shallowRef("");
		const instructionsBaseline = shallowRef("");
		const awaitingSync = shallowRef<string>();
		const instructionsOpen = shallowRef(false);
		const restore = useConfirmation();
		const waiting = computed(() => awaitingSync.value !== undefined);
		const conflict = computed(() => instructionsDirty.value && !waiting.value && controller.store.instructions.value !== instructionsBaseline.value);
		const instructionsForcedOpen = computed(() => instructionsDirty.value || conflict.value || waiting.value);
		watch([controller.store.instructions, instructionsPending], ([value, pending]) => {
			if (pending) return;
			if (awaitingSync.value !== undefined && value === awaitingSync.value) {
				awaitingSync.value = undefined;
				instructionsDirty.value = false;
			}
			if (!instructionsDirty.value) {
				instructionsDraft.value = value;
				instructionsBaseline.value = value;
			}
		}, { immediate: true });

		const chooseDelivery = async (mode: BusyMode) => {
			if (deliveryPending.value) return;
			const source = controller.workspace;
			if (!source) return toast(t("reconnecting"), "error");
			if (source.busyMode.value === mode) return;
			deliveryPending.value = true;
			try { await source.setBusyMode(mode, context); } catch (error) { toastError(error); } finally { deliveryPending.value = false; }
		};
		const choosePreference = async (key: Preference, enabled: boolean) => {
			if (preferencePending.value) return;
			const source = controller.workspace;
			if (!source) return toast(t("reconnecting"), "error");
			preferencePending.value = true;
			try { await source.setPreference({ key, enabled }, context); } catch (error) { toastError(error); } finally { preferencePending.value = false; }
		};
		const preference = (key: Preference, label: string) => (
			<label class="setting-row"><span>{label}</span><input type="checkbox" id={`settings-${key}`}
				checked={controller.store.preferences.value[key]} disabled={preferencePending.value || !controller.workspace}
				onChange={(event) => void choosePreference(key, (event.target as HTMLInputElement).checked)} /></label>
		);
		const mutateInstructions = async (instructions?: string) => {
			if (instructionsPending.value) return;
			const source = controller.workspace;
			if (!source) return toast(t("reconnecting"), "error");
			restore.reset();
			instructionsPending.value = true;
			instructionsDirty.value = true;
			awaitingSync.value = undefined;
			try {
				awaitingSync.value = instructions === undefined ? await source.resetInstructions(context) : await source.setInstructions({ instructions }, context);
				toast(t(instructions === undefined ? "settings.instructionsRestored" : "settings.instructionsSaved"));
			} catch (error) { toastError(error); } finally { instructionsPending.value = false; restore.reset(); }
		};
		const preview = computed(() => {
			if (instructionsDirty.value) return t("settings.instructionsUnsaved");
			const value = controller.store.instructions.value.replace(/\s+/g, " ").trim();
			return value.length > 60 ? `${value.slice(0, 60)}…` : value;
		});

		return () => {
			const providers = controller.store.providers.value.filter((provider) => provider.kind === "custom" || provider.configured);
			return (
				<section class="sheet" id="settings" role="dialog" aria-modal="true" aria-label={t("settings.title")}>
					<div class="panel-head">
						<button class="icon-btn" id="settings-back" type="button" aria-label={t("settings.back")} onClick={() => controller.overlays.close()}><Icon name="back" size={18} /></button>
						<span class="panel-title">{t("settings.title")}</span>
					</div>
					<div class="sheet-body">
						<section class="section">
							<div class="section-heading"><h3>{t("settings.providers")}</h3>
								<button class="btn small" id="add-provider" type="button" onClick={() => controller.openProviderEditor()}><Icon name="plus" size={14} />{t("settings.addProvider")}</button></div>
							<div class="card providers" id="providers">
								{providers.length ? providers.map((provider) => {
									const status = provider.configured ? t("settings.configured") : t("settings.notConfigured");
									return (
										<div class="provider" data-provider={provider.id} key={provider.id}>
											<button class="provider-head" type="button" aria-haspopup="dialog" aria-label={`${provider.name}: ${status}`}
												onClick={() => controller.openProviderEditor(provider.id)}>
												<span class="provider-name">{provider.name}</span>
												{provider.configured ? <span class="status-dot" data-on="true" aria-hidden="true" /> : <span class="pill">{status}</span>}
												<Icon name="chevron" size={14} />
											</button>
										</div>
									);
								}) : <div class="list-empty" id="providers-empty">{t("settings.noProviders")}</div>}
							</div>
						</section>
						<section class="section"><h3>{t("settings.safety")}</h3><div class="card">{preference("confirmActions", t("settings.confirmActions"))}</div></section>
						<section class="section"><h3>{t("settings.conversation")}</h3><div class="card">
							{preference("autoTitle", t("settings.autoTitle"))}{preference("autoCompaction", t("settings.autoCompaction"))}{preference("autoRetry", t("settings.autoRetry"))}
						</div></section>
						<section class="section"><h3>{t("settings.messaging")}</h3>
							<Segmented id="settings-delivery" label={t("settings.messaging")} selected={controller.store.busyMode.value}
								disabled={deliveryPending.value} options={[{ value: "steer", label: t("queue.steer") }, { value: "followUp", label: t("queue.followUp") }]}
								onChoose={(mode) => void chooseDelivery(mode)} /></section>
						<section class="section"><h3>{t("settings.appearance")}</h3>
							<Segmented label={t("settings.appearance")} selected={theme.value} options={(["system", "light", "dark"] as const).map((value) => ({ value, label: t(`settings.theme.${value}`) }))}
								onChoose={(value) => { applyTheme(value); theme.value = value; }} /></section>
						<section class="section"><h3>{t("settings.language")}</h3>
							<Segmented id="settings-language" label={t("settings.language")} selected={savedLanguagePreference()}
								options={[{ value: "system" as LanguagePreference, label: t("settings.theme.system") }, { value: "zh-CN" as LanguagePreference, label: "中文" }, { value: "en" as LanguagePreference, label: "English" }]}
								onChoose={(language) => { if (language !== savedLanguagePreference()) { saveLanguage(language); location.reload(); } }} /></section>
						<section class="section">
							<details class="fold" id="settings-instructions-details" open={instructionsForcedOpen.value || instructionsOpen.value}
								onToggle={(event) => {
									const details = event.target as HTMLDetailsElement;
									instructionsOpen.value = details.open;
									if (instructionsForcedOpen.value && !details.open) details.open = true;
								}}>
								<summary><span class="fold-title" id="settings-instructions-label">{t("settings.instructions")}</span>
									<span class="fold-preview" id="settings-instructions-preview" data-dirty={String(instructionsDirty.value)}>{preview.value}</span><Icon name="chevron" size={14} /></summary>
								<div class="fold-body">
									<textarea class="instructions-input" id="settings-instructions" rows={9} spellcheck="false"
										aria-labelledby="settings-instructions-label" aria-describedby="settings-instructions-status"
										value={instructionsDraft.value} disabled={instructionsPending.value || !controller.workspace}
										onInput={(event) => {
											if (awaitingSync.value !== undefined) instructionsBaseline.value = awaitingSync.value;
											awaitingSync.value = undefined;
											instructionsDraft.value = (event.target as HTMLTextAreaElement).value;
											instructionsDirty.value = true;
										}} />
									<div class="provider-section-action">
										<button class="btn primary small" id="instructions-save" type="button" disabled={instructionsPending.value || !controller.workspace}
											onClick={() => void mutateInstructions(instructionsDraft.value)}>{t("settings.instructionsSave")}</button>
										<button class="btn small" id="instructions-restore" type="button" data-confirm={restore.armed.value ? "" : undefined}
											disabled={instructionsPending.value || !controller.workspace}
											onClick={() => restore.armed.value ? void mutateInstructions() : restore.arm()}>
											{t(restore.armed.value ? "settings.instructionsRestoreConfirm" : "settings.instructionsRestore")}
										</button>
									</div>
									{(conflict.value || waiting.value) && !instructionsPending.value && (
										<div class="instructions-status" id="settings-instructions-status" role="status">
											<span>{t(conflict.value ? "settings.instructionsChangedElsewhere" : "settings.instructionsWaitingForSync")}</span>
											<button class="btn small" id="instructions-load-latest" type="button" disabled={!controller.workspace}
												onClick={() => {
													awaitingSync.value = undefined;
													instructionsDirty.value = false;
													instructionsDraft.value = instructionsBaseline.value = controller.store.instructions.value;
													restore.reset();
												}}>{t("settings.instructionsLoadLatest")}</button>
										</div>
									)}
								</div>
							</details>
						</section>
						<section class="section"><h3>{t("settings.about")}</h3><div class="card about"><Logo size={34} />
							<div><strong>Oshawott</strong><span>{t("settings.version", ext.runtime.getManifest().version)}</span></div></div></section>
					</div>
				</section>
			);
		};
	},
});
