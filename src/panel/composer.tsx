import { computed, defineComponent, nextTick, shallowRef, watch } from "vue";
import type { PropType } from "vue";
import { ext } from "../platform/webext.ts";
import { AttachmentButton, AttachmentTray, Icon } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { t } from "./i18n/index.ts";
import { modelName, supportedThinkingLevels, supportsVision } from "./models.ts";

export const Composer = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const { controller } = props;
		const { composer, store } = controller;
		const root = shallowRef<HTMLElement>();
		const working = shallowRef<{ id: number; title?: string }>();
		const faviconFailed = shallowRef(false);
		const stop = computed(() => store.busy.value && !composer.hasContent.value);
		const thinkingLevels = computed(() => supportedThinkingLevels(store.providers.value, store.model.value));
		const visionBlocked = computed(() => composer.attachments.hasImages && !supportsVision(store.providers.value, store.model.value));
		const deliveryLabel = computed(() => t(store.busyMode.value === "steer" ? "queue.steer" : "queue.followUp"));

		watch(store.busy, (busy) => { document.body.dataset.busy = String(busy); }, { immediate: true });
		watch(() => composer.text, () => void nextTick(() => composer.resize()));
		watch(() => controller.tab.value?.url, () => { faviconFailed.value = false; });
		watch([store.busy, store.target], ([busy, target]) => {
			const id = busy && target !== null && target !== controller.tab.value?.id ? target : null;
			if (id === working.value?.id || (id === null && !working.value)) return;
			working.value = id === null ? undefined : { id };
			if (id !== null) {
				void ext.tabs.get(id).then((tab) => tab.title || tab.url || "", () => "").then((title) => {
					if (working.value?.id === id) working.value = { id, title };
				});
			}
		}, { immediate: true });

		const context = () => {
			const tab = controller.tab.value;
			const workingChip = working.value?.title ? (
				<button class="tab-chip working" id="working-tab" type="button" title={t("tab.workingHint")}
					onClick={() => void ext.tabs.update(working.value!.id, { active: true }).catch(() => undefined)}>
					<span class="spinner" /><span class="name">{t("tab.working", working.value!.title!)}</span>
				</button>
			) : null;
			if (!tab) return <><span class="tab-chip" data-available="false"><Icon name="globe" size={13} /><span class="name">{t("tab.none")}</span></span>{workingChip}</>;
			return (
				<>
					<span class="tab-chip" id="tab-chip" data-available={String(tab.available)} title={tab.available ? tab.url : t("tab.unavailable")}>
						{tab.favIconUrl && !faviconFailed.value
							? <img src={tab.favIconUrl} alt="" width={14} height={14} referrerpolicy="no-referrer" onError={() => { faviconFailed.value = true; }} />
							: <Icon name="globe" size={13} />}
						<span class="name">{tab.title}</span>
						{!tab.available && (
							<span class="tab-unavailable" title={t("tab.unavailable")}><Icon name="alert" size={12} /><span class="sr-only">{t("tab.unavailable")}</span></span>
						)}
					</span>
					{workingChip}
				</>
			);
		};

		return () => {
			const busy = store.busy.value;
			const hasContent = composer.hasContent.value;
			const ref = store.model.value;
			const ready = store.ready.value;
			const modelLabel = !ready ? t("model.connect") : ref ? modelName(store.providers.value, ref) : t("model.choose");
			const thinkingLabel = t(`thinking.level.${store.thinking.value}`);
			const sendTitle = stop.value ? t("composer.stop") : busy ? t("composer.sendBusy", deliveryLabel.value) : `${t("composer.send")} (Enter)`;
			return (
				<div class="composer" id="composer" data-drop-label={t("attachments.drop")} ref={root}
					onDragover={(event) => {
						if (!event.dataTransfer?.types.includes("Files")) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = "copy";
						if (root.value) root.value.dataset.dragging = "true";
					}}
					onDragleave={(event) => {
						if (!(event.relatedTarget instanceof Node) || !root.value?.contains(event.relatedTarget)) delete root.value?.dataset.dragging;
					}}
					onDrop={(event) => {
						if (!event.dataTransfer?.files.length) return;
						event.preventDefault();
						delete root.value?.dataset.dragging;
						void composer.attachments.addFiles([...event.dataTransfer.files]);
					}}>
					<div class="context-row" id="context">{context()}</div>
					{visionBlocked.value && (
						<div class="composer-notice" id="vision-warning" role="alert">
							<Icon name="alert" size={15} /><span>{t("composer.vision", ref ? modelName(store.providers.value, ref) : t("model.choose"))}</span>
							<button class="btn small" type="button" onClick={() => controller.openModelMenu()}>{t("failure.chooseModel")}</button>
						</div>
					)}
					<AttachmentTray picker={composer.attachments} />
					<textarea id="prompt" rows={1} placeholder={busy ? t("composer.placeholderBusy") : t("composer.placeholder")}
						aria-label={t("composer.placeholder")} value={composer.text} ref={composer.prompt}
						onInput={(event) => composer.editText((event.target as HTMLTextAreaElement).value)}
						onKeydown={(event) => {
							if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
							event.preventDefault();
							void controller.send();
						}}
						onPaste={(event) => {
							const files = [...event.clipboardData?.files ?? []];
							if (!files.length) return;
							event.preventDefault();
							void composer.attachments.addFiles(files);
						}} />
					<div class="composer-bar">
						<button class="model-btn" id="model" type="button" aria-haspopup="listbox" data-attention={String(!ready)}
							disabled={store.configuring.value} ref={composer.modelButton} onClick={() => controller.openModelMenu()}>
							<Icon name={ready ? "spark" : "key"} size={14} /><span class="model-name">{modelLabel}</span><Icon name="chevron" size={12} />
						</button>
						<button class="model-btn thinking-btn" id="thinking" type="button" aria-haspopup="listbox" data-level={store.thinking.value}
							hidden={!ready || !ref || thinkingLevels.value.length < 2}
							disabled={store.configuring.value} title={`${t("thinking.menuTitle")}: ${thinkingLabel}`} aria-label={`${t("thinking.menuTitle")}: ${thinkingLabel}`}
							ref={composer.thinkingButton} onClick={() => controller.openThinkingMenu()}>
							<Icon name="bulb" size={14} /><span class="model-name">{thinkingLabel}</span><Icon name="chevron" size={12} />
						</button>
						<AttachmentButton picker={composer.attachments} />
						<button class="send-btn stop-btn" id="stop" type="button" title={t("composer.stop")} aria-label={t("composer.stop")} hidden={!busy || !hasContent}
							ref={composer.stopButton} onClick={() => controller.requestStop(composer.stopButton.value!)}><Icon name="stop" size={16} /></button>
						<button class="send-btn" id="send" type="button" data-mode={stop.value ? "stop" : "send"}
							disabled={store.sending.value || (!stop.value && !hasContent)} title={sendTitle}
							aria-label={stop.value ? t("composer.stop") : busy ? deliveryLabel.value : t("composer.send")}
							ref={composer.sendButton} onClick={() => stop.value ? controller.requestStop(composer.sendButton.value!) : void controller.send()}>
							<Icon name={stop.value ? "stop" : "send"} size={16} />
						</button>
					</div>
				</div>
			);
		};
	},
});
