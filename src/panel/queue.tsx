import { computed, defineComponent, onBeforeUnmount, shallowRef, watch, type PropType } from "vue";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import type { BusyMode } from "../contracts/chat.ts";
import { type AttachmentRef, userInput } from "../lib/attachments.ts";
import { AttachmentPicker, pendingInput } from "./attachments.ts";
import { AttachmentButton, AttachmentTray, Icon } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { t } from "./i18n/index.ts";
import type { QueueItem } from "./store.ts";
import { toast, toastError } from "./ui.ts";

type Editing = {
	id: number; text: string; mode: BusyMode; requestId: string;
	existing: AttachmentRef[]; removed: Set<string>; picker: AttachmentPicker;
};
const inputOf = (item: QueueItem) => userInput(item.entry, item.content);
const modeLabel = (mode: BusyMode) => t(mode === "steer" ? "queue.steer" : "queue.followUp");

/** The inbox projection is durable; only the editor draft is local. */
export const MessageQueue = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const { controller } = props;
		const editing = shallowRef<Editing>();
		const pending = shallowRef(false);
		const failed = computed(() => Boolean(!controller.store.live.value?.run && controller.store.live.value?.runFailure));
		const closeEditor = () => {
			editing.value?.picker.dispose();
			editing.value = undefined;
		};
		watch(controller.store.queue, (items) => {
			if (editing.value && !items.some((item) => item.id === editing.value!.id)) {
				closeEditor();
				if (controller.store.view.value) toast(t("queue.unavailable"), "error");
			}
			if (!items.length) closeEditor();
		});
		onBeforeUnmount(closeEditor);

		const perform = async (action: () => Promise<void>) => {
			if (pending.value) return;
			pending.value = true;
			try { await action(); } catch (error) { toastError(error); } finally { pending.value = false; }
		};
		const save = (item: QueueItem) => {
			const draft = editing.value;
			if (!draft) return;
			const kept = draft.existing.some((attachment) => !draft.removed.has(attachment.path));
			if (!draft.text.trim() && !kept && !draft.picker.items.length) return;
			void perform(async () => {
				const result = await controller.session.opened.updateQueued({
					id: item.id, text: draft.text.trim(), whenBusy: draft.mode, requestId: draft.requestId,
					attachments: draft.picker.items.map(pendingInput), removeAttachments: [...draft.removed],
				}, controllerContext);
				if (editing.value?.id !== item.id) return;
				if (result === "not_found") toast(t("queue.unavailable"), "error");
				closeEditor();
			});
		};

		const editor = (item: QueueItem, draft: Editing) => (
			<div class="queue-edit-card">
				<textarea class="queue-editor" rows={2} aria-label={t("queue.edit")} value={draft.text} disabled={pending.value}
					onInput={(event) => { draft.text = (event.target as HTMLTextAreaElement).value; }}
					onKeydown={(event) => {
						if (event.key === "Escape") { event.preventDefault(); closeEditor(); }
						else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(item); }
					}} />
				<div class="queue-existing-attachments">
					{draft.existing.filter((attachment) => !draft.removed.has(attachment.path)).map((attachment) => (
						<span class="queue-attachment" data-path={attachment.path}>
							<Icon name={attachment.mimeType.startsWith("image/") ? "eye" : "file"} size={12} /><span>{attachment.name}</span>
							<button class="icon-btn small queue-attachment-remove" type="button" title={t("attachments.remove")}
								aria-label={`${t("attachments.remove")}: ${attachment.name}`} disabled={pending.value}
								onClick={() => { editing.value = { ...draft, removed: new Set([...draft.removed, attachment.path]) }; }}>
								<Icon name="x" size={11} />
							</button>
						</span>
					))}
				</div>
				<AttachmentTray picker={draft.picker} id={`queue-attachment-tray-${item.id}`} />
				<div class="queue-edit-bar">
					<AttachmentButton picker={draft.picker} id={`queue-attach-${item.id}`} inputId={`queue-attachment-input-${item.id}`} disabled={pending.value} />
					<span class="queue-edit-delivery">
						<select class="queue-edit-mode" aria-label={t("queue.delivery")} value={draft.mode} disabled={pending.value}
							onChange={(event) => { draft.mode = (event.target as HTMLSelectElement).value as BusyMode; }}>
							<option value="followUp">{t("queue.followUp")}</option><option value="steer">{t("queue.steer")}</option>
						</select>
						<Icon name="chevron" size={12} />
					</span>
					<div class="queue-edit-actions">
						<button class="btn ghost small queue-edit-cancel" type="button" disabled={pending.value} onClick={closeEditor}>{t("queue.cancelEdit")}</button>
						<button class="btn primary small queue-save" type="button" disabled={pending.value} onClick={() => save(item)}>{t("queue.save")}</button>
					</div>
				</div>
			</div>
		);

		const row = (item: QueueItem) => {
			const draft = editing.value?.id === item.id ? editing.value : undefined;
			const other: BusyMode = item.mode === "steer" ? "followUp" : "steer";
			return (
				<article class="queue-item" data-submission-id={item.id} data-mode={item.mode} data-editing={draft ? "true" : undefined} key={item.id}>
					{draft ? editor(item, draft) : (
						<>
							<button class="queue-mode" type="button" data-action="mode" disabled={pending.value}
								title={t(other === "steer" ? "queue.switchSteer" : "queue.switchFollowUp")}
								onClick={() => void perform(async () => {
									const result = await controller.session.opened.updateQueued({ id: item.id, whenBusy: other }, controllerContext);
									if (result !== "updated") toast(t("queue.unavailable"), "error");
								})}>{modeLabel(item.mode)}<Icon name="chevron" size={11} /></button>
							<div class="queue-copy"><div class="queue-text">{inputOf(item).text}</div>
								<div class="queue-attachments">{inputOf(item).attachments.map((attachment) => (
									<span class="queue-attachment"><Icon name={attachment.mimeType.startsWith("image/") ? "eye" : "file"} size={11} />{attachment.name}</span>
								))}</div></div>
							<button class="icon-btn small queue-edit" type="button" title={t("queue.edit")} aria-label={t("queue.edit")} disabled={pending.value}
								onClick={() => {
									closeEditor();
									editing.value = {
										id: item.id, text: inputOf(item).text, mode: item.mode, requestId: crypto.randomUUID(),
										existing: inputOf(item).attachments, removed: new Set(), picker: new AttachmentPicker(),
									};
								}}><Icon name="compose" size={14} /></button>
							<button class="icon-btn small queue-cancel" type="button" title={t("queue.cancel")} aria-label={t("queue.cancel")} disabled={pending.value}
								onClick={() => void perform(async () => {
									const result = await controller.session.opened.cancelQueued({ id: item.id }, controllerContext);
									if (result !== "aborted") toast(t("queue.unavailable"), "error");
								})}><Icon name="x" size={14} /></button>
						</>
					)}
				</article>
			);
		};

		return () => (
			<section class="queue" id="queue" aria-label={t("queue.title")} hidden={!controller.store.queue.value.length}>
				{controller.store.queue.value.length > 0 && <>
					<div class="queue-head"><strong>{t("queue.count", controller.store.queue.value.length)}</strong>
						{failed.value && <button class="btn small queue-continue" type="button" disabled={pending.value}
							onClick={() => void perform(async () => { await controller.session.opened.continueQueued(controllerContext); })}>
							<Icon name="refresh" size={13} />{t("queue.continue")}</button>}</div>
					<div class="queue-list">{controller.store.queue.value.map(row)}</div>
				</>}
			</section>
		);
	},
});

const controllerContext = BACKGROUND_CONTEXT;
