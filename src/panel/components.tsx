import { defineComponent, onBeforeUnmount, ref, shallowRef, watch, type PropType } from "vue";
import { formatBytes } from "../lib/bytes.ts";
import { ATTACHMENT_ACCEPT, type AttachmentPicker } from "./attachments.ts";
import { t } from "./i18n/index.ts";
import { ICONS, type IconName } from "./ui.ts";

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
	return (
		<svg class="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
			{ICONS[name].map((shape) => {
				if (shape.startsWith("c:")) {
					const [cx, cy, r] = shape.slice(2).split(",");
					return <circle cx={cx} cy={cy} r={r} />;
				}
				if (shape.startsWith("r:")) {
					const [x, y, width, height, rx] = shape.slice(2).split(",");
					return <rect x={x} y={y} width={width} height={height} rx={rx} />;
				}
				return <path d={shape} />;
			})}
		</svg>
	);
}

export const Logo = ({ size = 24 }: { size?: number }) => (
	<img class="logo" src={`icons/${size <= 32 ? "icon-small.svg" : "icon.svg"}`} width={size} height={size} alt="" draggable={false} aria-hidden="true" />
);
export const Mascot = ({ size = 56 }: { size?: number }) => (
	<img class="mascot" src="icons/mascot.svg" width={size} height={size} alt="" draggable={false} aria-hidden="true" />
);

export function Segmented<T extends string>(props: {
	id?: string;
	label: string;
	options: readonly { value: T; label: string; id?: string }[];
	selected: T;
	disabled?: boolean;
	onChoose(value: T, focus: boolean): void;
}) {
	const choose = (value: T, focus: boolean) => props.onChoose(value, focus);
	return (
		<div class="segmented" id={props.id} role="radiogroup" aria-label={props.label}>
			{props.options.map((option, index) => (
				<button
					type="button" role="radio" id={option.id} data-value={option.value} disabled={props.disabled}
					aria-checked={props.selected === option.value} tabindex={props.selected === option.value ? 0 : -1}
					onClick={() => choose(option.value, false)}
					onKeydown={(event) => {
						const last = props.options.length - 1;
						const next = event.key === "ArrowRight" || event.key === "ArrowDown" ? (index + 1) % props.options.length
							: event.key === "ArrowLeft" || event.key === "ArrowUp" ? (index + last) % props.options.length
								: event.key === "Home" ? 0 : event.key === "End" ? last : -1;
						if (next < 0) return;
						event.preventDefault();
						const buttons = (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>("button");
						buttons?.[next]?.focus({ preventScroll: true });
						choose(props.options[next]!.value, true);
					}}
				>{option.label}</button>
			))}
		</div>
	);
}

export const AttachmentTray = defineComponent({
	props: { picker: { type: Object as PropType<AttachmentPicker>, required: true }, id: { type: String, default: "attachment-tray" } },
	setup(props) {
		return () => (props.picker.items.length || props.picker.errors.length) ? (
			<div class="attachment-tray" id={props.id} aria-label={t("attachments.title")}>
				{props.picker.items.map((item) => (
					<div class="attachment-chip" data-attachment-id={item.id} key={item.id}>
						{item.previewUrl
							? <img class="attachment-preview" src={item.previewUrl} alt="" width={36} height={36} />
							: <span class="attachment-file-icon"><Icon name="file" size={17} /></span>}
						<span class="attachment-chip-copy">
							<span class="attachment-name" title={item.name}>{item.name}</span>
							<span class="attachment-size">{formatBytes(item.data.length)}</span>
						</span>
						<button class="icon-btn small attachment-remove" type="button" title={t("attachments.remove")}
							aria-label={`${t("attachments.remove")}: ${item.name}`} onClick={() => props.picker.remove(item.id)}>
							<Icon name="x" size={13} />
						</button>
					</div>
				))}
				{props.picker.errors.map((error) => (
					<div class="attachment-chip attachment-error" role="alert" key={error.id}>
						<Icon name="alert" size={16} />
						<span class="attachment-chip-copy"><span class="attachment-name">{error.name}</span><span class="attachment-size">{error.message}</span></span>
						<button class="icon-btn small" type="button" title={t("attachments.dismiss")} aria-label={t("attachments.dismiss")}
							onClick={() => props.picker.dismissError(error.id)}><Icon name="x" size={13} /></button>
					</div>
				))}
			</div>
		) : null;
	},
});

export const AttachmentButton = defineComponent({
	props: {
		picker: { type: Object as PropType<AttachmentPicker>, required: true },
		id: { type: String, default: "attach" }, inputId: { type: String, default: "attachment-input" },
		disabled: Boolean,
	},
	setup(props) {
		const input = shallowRef<HTMLInputElement>();
		return () => (
			<>
				<button class="icon-btn attachment-add" id={props.id} type="button" title={t("attachments.add")} aria-label={t("attachments.add")}
					disabled={props.disabled} onClick={() => input.value?.click()}><Icon name="paperclip" size={17} /></button>
				<input class="attachment-input" id={props.inputId} type="file" multiple accept={ATTACHMENT_ACCEPT} hidden ref={input}
					onChange={() => {
						void props.picker.addFiles([...input.value?.files ?? []]);
						if (input.value) input.value.value = "";
					}} />
			</>
		);
	},
});

/** A narrow boundary for the imperative Markdown and tool-card kernels. */
export const NativeView = defineComponent({
	props: { element: { type: Object as PropType<HTMLElement>, required: true } },
	setup(props) {
		const host = shallowRef<HTMLElement>();
		const attach = (element: HTMLElement | undefined) => {
			if (!host.value) return;
			host.value.replaceChildren(...(element ? [element] : []));
		};
		watch(() => props.element, (element, previous) => {
			previous?.remove();
			attach(element);
		});
		watch(host, () => attach(props.element), { flush: "post" });
		onBeforeUnmount(() => props.element.remove());
		return () => <div class="native-view" ref={host} />;
	},
});

export function Notice({ tone, text, detail, icon = "alert" }: { tone: "error" | "warn" | "info"; text: string; detail?: string; icon?: IconName }) {
	return (
		<div class="notice" data-tone={tone} role={tone === "error" ? "alert" : "status"}>
			<span class="notice-icon"><Icon name={icon} size={16} /></span>
			<div class="notice-body"><div>{text}</div>{detail && <div class="notice-detail">{detail}</div>}</div>
		</div>
	);
}

export function useConfirmation(timeoutMs = 3000) {
	const armed = ref(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reset = () => { clearTimeout(timer); timer = undefined; armed.value = false; };
	const arm = () => {
		if (armed.value) return;
		armed.value = true;
		timer = setTimeout(reset, timeoutMs);
	};
	onBeforeUnmount(reset);
	return { armed, arm, reset };
}
