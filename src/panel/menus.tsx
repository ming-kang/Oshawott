import { computed, defineComponent, nextTick, onMounted, ref, shallowRef, watch, type PropType } from "vue";
import type { BusyMode, ModelRef, ThinkingLevel } from "../contracts/chat.ts";
import { t } from "./i18n/index.ts";
import { compactTokens, configuredProviders, sameModel } from "./models.ts";
import type { PanelController } from "./controller.ts";
import { Icon } from "./components.tsx";
import { toastError } from "./ui.ts";

export const ModelMenu = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const query = ref("");
		const search = shallowRef<HTMLInputElement>();
		const list = shallowRef<HTMLElement>();
		const active = ref(0);
		const groups = computed(() => {
			let index = 0;
			return configuredProviders(props.controller.store.providers.value)
				.map((provider) => ({
					provider,
					models: provider.models
						.filter((model) => !query.value.trim() || `${model.name} ${model.id}`.toLowerCase().includes(query.value.trim().toLowerCase()))
						.map((model) => ({ model, index: index++ })),
				}))
				.filter((group) => group.models.length);
		});
		const options = computed(() => groups.value.flatMap((group) => group.models.map(({ model, index }) => ({
			index, ref: { provider: group.provider.id, modelId: model.id },
		}))));
		const activate = (index: number) => {
			const count = options.value.length;
			active.value = count ? Math.max(0, Math.min(index, count - 1)) : 0;
			void nextTick(() => list.value?.querySelector(`#model-option-${active.value}`)?.scrollIntoView({ block: "nearest" }));
		};
		watch(options, (items) => {
			const selected = props.controller.store.model.value;
			const index = items.findIndex((item) => sameModel(selected, item.ref));
			activate(index >= 0 ? index : 0);
		}, { immediate: true });
		onMounted(() => search.value?.focus());
		const pick = async (model: ModelRef) => {
			await props.controller.session.configure({ model, thinkingLevel: props.controller.session.thinkingFor(model) });
			props.controller.overlays.closeIf("model");
		};
		return () => (
			<div class="popover" id="model-menu">
				<input class="menu-search" type="search" placeholder={t("model.search")} aria-label={t("model.search")}
					role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="model-options"
					aria-activedescendant={options.value.length ? `model-option-${active.value}` : undefined}
					value={query.value} ref={search}
					onInput={(event) => { query.value = (event.target as HTMLInputElement).value; }}
					onKeydown={(event) => {
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							activate(active.value + (event.key === "ArrowDown" ? 1 : -1));
						} else if (event.key === "Home" || event.key === "End") {
							event.preventDefault();
							activate(event.key === "Home" ? 0 : options.value.length - 1);
						} else if (event.key === "Enter") {
							event.preventDefault();
							const option = options.value[active.value];
							if (option) void pick(option.ref).catch(toastError);
						}
					}} />
				<div class="menu-list" id="model-options" role="listbox" aria-label={t("model.choose")} ref={list}>
					{groups.value.length ? groups.value.map(({ provider, models }) => (
						<>
							<div class="menu-group">{provider.name}</div>
							{models.map(({ model, index }) => {
								const ref = { provider: provider.id, modelId: model.id };
								const chosen = sameModel(props.controller.store.model.value, ref);
								return (
									<button class={{ "menu-item": true, active: active.value === index }} id={`model-option-${index}`} type="button" role="option"
										tabindex={-1} aria-selected={chosen} data-provider={provider.id} data-model={model.id}
										onMouseenter={() => { active.value = index; }} onClick={() => void pick(ref).catch(toastError)}>
										<span class="menu-item-name">{model.name}<span class="menu-item-details">{[
											model.name !== model.id ? model.id : "", compactTokens(model.contextWindow), model.vision ? t("model.vision") : "",
										].filter(Boolean).join(" · ")}</span></span>
										{chosen && <Icon name="check" size={14} />}
									</button>
								);
							})}
						</>
					)) : <div class="list-empty" role="status">{t("model.none")}</div>}
				</div>
			</div>
		);
	},
});

export const ThinkingMenu = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		levels: { type: Array as PropType<readonly ThinkingLevel[]>, required: true },
	},
	setup(props) {
		const list = shallowRef<HTMLElement>();
		onMounted(() => {
			(list.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? list.value?.querySelector<HTMLButtonElement>("button"))?.focus();
		});
		const pick = async (level: ThinkingLevel) => {
			const model = props.controller.store.model.value;
			if (!model) return;
			await props.controller.session.configure({ model, thinkingLevel: level });
			props.controller.overlays.closeIf("thinking");
		};
		return () => (
			<div class="popover thinking-menu" id="thinking-menu">
				<div class="menu-group" id="thinking-menu-title">{t("thinking.menuTitle")}</div>
				<div class="menu-list" role="listbox" aria-labelledby="thinking-menu-title" ref={list}>
					{props.levels.map((level) => (
						<button class="menu-item" type="button" role="option" aria-selected={level === props.controller.store.thinking.value}
							data-level={level} onClick={() => void pick(level).catch(toastError)}>
							<span class="menu-item-name">{t(`thinking.level.${level}`)}</span>
							{level === props.controller.store.thinking.value && <Icon name="check" size={14} />}
						</button>
					))}
				</div>
			</div>
		);
	},
});

const modeLabel = (mode: BusyMode) => t(mode === "steer" ? "queue.steer" : "queue.followUp");
export const SendModeMenu = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const menu = shallowRef<HTMLElement>();
		const modes = ["followUp", "steer"] as const;
		onMounted(() => {
			(menu.value?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.value?.querySelector<HTMLButtonElement>("button"))?.focus();
		});
		const pick = (mode: BusyMode) => {
			props.controller.overlays.close();
			props.controller.composer.focus();
			void props.controller.session.setBusyMode(mode).catch(toastError);
		};
		return () => (
			<div class="popover send-mode-menu" role="menu" aria-label={t("composer.delivery")} ref={menu}
				onKeydown={(event) => {
					if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>("button")];
					const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
					const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
						: (Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
					buttons[next]?.focus();
				}}>
				{modes.map((mode) => (
					<button class="menu-item" type="button" role="menuitemradio" aria-checked={props.controller.store.busyMode.value === mode}
						data-mode={mode} onClick={() => pick(mode)}>
						<span class="menu-check">{props.controller.store.busyMode.value === mode && <Icon name="check" size={14} />}</span>
						<span class="send-mode-copy"><span class="menu-item-name">{modeLabel(mode)}</span>
							<span class="send-mode-description">{t(mode === "steer" ? "queue.steerDescription" : "queue.followUpDescription")}</span></span>
					</button>
				))}
			</div>
		);
	},
});

export const StopConfirmMenu = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true }, count: { type: Number, required: true },
		confirm: { type: Function as PropType<() => void>, required: true },
	},
	setup(props) {
		const cancel = shallowRef<HTMLButtonElement>();
		onMounted(() => cancel.value?.focus({ preventScroll: true }));
		return () => (
			<div class="popover stop-confirm-menu" role="dialog" aria-label={t("composer.stop")}>
				<p>{t("composer.stopQueue", props.count)}</p>
				<div class="stop-confirm-actions">
					<button class="btn small queue-stop-cancel" type="button" ref={cancel} onClick={() => props.controller.overlays.close()}>{t("queue.keepRunning")}</button>
					<button class="btn danger small queue-stop-confirm" type="button" onClick={props.confirm}>{t("composer.stop")}</button>
				</div>
			</div>
		);
	},
});
