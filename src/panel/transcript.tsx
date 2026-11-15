import { defineComponent, nextTick, onBeforeUnmount, onMounted, shallowReactive, shallowRef, watch, type PropType } from "vue";
import type { AssistantMessage, ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { ToolResultEntry, type EntryRecord, type RunFailure, type RunFailureReason } from "@earendil-works/pi-durable";
import { isImageAttachment, type AttachmentRef, USER_ENTRY, userInput } from "../lib/attachments.ts";
import { fromBase64 } from "../lib/base64.ts";
import { formatBytes } from "../lib/bytes.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { AssistantView } from "./assistant-view.ts";
import { Icon, Mascot, NativeView, Notice } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { t } from "./i18n/index.ts";
import { ToolCard } from "./tool-card.ts";
import { hasVisibleAnswer, transcriptItems, type TranscriptItem } from "./transcript-model.ts";
import { copyButton, download, h, type IconName, icon, toastError } from "./ui.ts";

const FAILURE_LABELS = {
	no_model: "failure.no_model", model_error: "failure.model_error", interrupted: "failure.interrupted", turn_limit: "failure.turn_limit",
	aborted: "failure.aborted", reset: null, faulted: null, orphaned: null, restart_limit: null, nothing_to_answer: null,
} as const satisfies Record<RunFailureReason, string | null>;
const textOf = (content: UserMessage["content"] | Extract<UserMessage["content"][number], { type: "text" }>[]) =>
	typeof content === "string" ? content : content.map((block) => block.type === "text" ? block.text : "").join("");

function noticeElement(tone: "error" | "warn" | "info", text: string, detail?: string, iconName: IconName = "alert") {
	return h("div", { class: "notice", "data-tone": tone, role: tone === "error" ? "alert" : "status", "data-commit": "true" },
		h("span", { class: "notice-icon" }, icon(iconName, 16)),
		h("div", { class: "notice-body" }, h("div", null, text), detail ? h("div", { class: "notice-detail" }, detail) : null));
}

const UserAttachment = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		attachment: { type: Object as PropType<AttachmentRef>, required: true }, native: { type: Object as PropType<ImageContent> },
	},
	setup(props) {
		const preview = shallowRef(props.native ? `data:${props.native.mimeType};base64,${props.native.data}` : "");
		const failed = shallowRef(false);
		const downloading = shallowRef(false);
		let bytes: Promise<Uint8Array> | undefined;
		let objectUrl: string | undefined;
		let disposed = false;
		const load = () => {
			bytes ??= props.native ? Promise.resolve(fromBase64(props.native.data)) : props.controller.session.opened.readFile({ path: props.attachment.path }, BACKGROUND_CONTEXT);
			return bytes.catch((error) => { bytes = undefined; throw error; });
		};
		if (isImageAttachment(props.attachment) && !props.native) {
			void load().then((data) => {
				if (disposed) return;
				objectUrl = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: props.attachment.mimeType }));
				preview.value = objectUrl;
			}).catch(() => { if (!disposed) failed.value = true; });
		}
		onBeforeUnmount(() => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); });
		return () => (
			<button class={{ "user-attachment": true, image: isImageAttachment(props.attachment), failed: failed.value }} type="button"
				data-path={props.attachment.path} title={`${t("files.download")}: ${props.attachment.name}`} disabled={downloading.value}
				onClick={async () => {
					downloading.value = true;
					try { download(await load(), props.attachment.name, props.attachment.mimeType); }
					catch (error) { failed.value = true; toastError(error); }
					finally { downloading.value = false; }
				}}>
				{preview.value ? <img class="user-attachment-preview" src={preview.value} alt="" />
					: failed.value ? <Icon name="alert" size={17} /> : isImageAttachment(props.attachment) ? <span class="attachment-loading"><span class="spinner" /></span> : <Icon name="file" size={18} />}
				<span class="user-attachment-copy"><span class="attachment-name">{props.attachment.name}</span>
					<span class="attachment-size">{formatBytes(props.attachment.size)}{props.attachment.lines !== undefined ? ` · ${t("attachments.lines", props.attachment.lines)}` : ""}</span></span>
				<Icon name="download" size={14} />
				{failed.value && <span class="sr-only">{t("files.download")}</span>}
			</button>
		);
	},
});

const UserRow = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true }, entry: { type: Object as PropType<EntryRecord>, required: true } },
	setup(props) {
		return () => {
			const message = props.entry.model?.[0];
			if (message?.role !== "user") return null;
			const { text, attachments } = userInput(props.entry, message.content);
			const images = typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "image");
			let imageIndex = 0;
			const referenced = attachments.map((attachment) => ({ attachment, native: isImageAttachment(attachment) ? images[imageIndex++] : undefined }));
			return (
				<div class="msg user"><div class="bubble">
					{text && <div class="user-text">{text}</div>}
					{referenced.length > 0 && <div class="user-attachments">{referenced.map(({ attachment, native }) => (
						<UserAttachment controller={props.controller} attachment={attachment} native={native} key={attachment.path} />
					))}</div>}
					{images.slice(attachments.filter(isImageAttachment).length).map((image) => <img class="user-image" src={`data:${image.mimeType};base64,${image.data}`} alt={t("attachments.title")} />)}
				</div></div>
			);
		};
	},
});

const AssistantRow = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true }, item: { type: Object as PropType<TranscriptItem>, required: true },
		cards: { type: Object as PropType<Map<string, ToolCard>>, required: true }, syncCards: { type: Function as PropType<() => void>, required: true },
	},
	setup(props) {
		const assistant = new AssistantView((site) => props.controller.failureMessage(site));
		const registered = new Set<string>();
		watch(() => props.item, (item) => {
			let message: AssistantMessage | undefined;
			let live = false;
			if (item.kind === "live") { message = item.message; live = true; }
			else if (item.kind === "entry" && item.entry.kind === "pi.assistant") {
				const candidate = item.entry.model?.[0];
				if (candidate?.role === "assistant") message = candidate;
			}
			if (!message) return;
			assistant.update(message, live);
			for (const [id, card] of assistant.cards) { props.cards.set(id, card); registered.add(id); }
			if (!live) {
				if (message.stopReason === "error" && message.errorMessage) assistant.element.append(noticeElement("error", t("failure.model_error"), message.errorMessage));
				const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n").trim();
				if (text && !message.content.some((block) => block.type === "toolCall")) assistant.element.append(h("div", { class: "msg-actions" }, copyButton(() => text, t("copy"))));
			}
			void nextTick(props.syncCards);
		}, { immediate: true });
		onBeforeUnmount(() => {
			const owned = assistant.cards;
			assistant.dispose();
			for (const id of registered) if (props.cards.get(id) === owned.get(id)) props.cards.delete(id);
		});
		return () => <NativeView element={assistant.element} />;
	},
});

const ToolResultRow = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true }, entry: { type: Object as PropType<EntryRecord>, required: true },
		cards: { type: Object as PropType<Map<string, ToolCard>>, required: true },
	},
	setup(props) {
		const message = props.entry.model?.[0];
		if (message?.role !== "toolResult") return () => null;
		const text = textOf(message.content);
		const diagnostics = ToolResultEntry.is(props.entry) ? props.entry.data?.diagnostics : undefined;
		let orphan: ToolCard | undefined;
		const element = h("div", { class: "msg assistant" }, h("div", { class: "tools" }));
		watch(() => props.cards.get(message.toolCallId), (card) => {
			if (card) card.setResult(text, message.isError, message.details, diagnostics);
			else if (!orphan) {
				orphan = new ToolCard(message.toolName, {}, (site) => props.controller.failureMessage(site));
				orphan.setResult(text, message.isError, message.details, diagnostics);
				element.firstElementChild?.append(orphan.element);
			}
		}, { immediate: true });
		return () => props.cards.get(message.toolCallId) ? null : <NativeView element={element} />;
	},
});

const HistoryButton = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true }, item: { type: Object as PropType<TranscriptItem>, required: true },
	},
	setup(props) {
		const pending = shallowRef(false);
		const load = async () => {
			if (pending.value) return;
			pending.value = true;
			const scroller = props.controller.scroller.value;
			const height = scroller?.scrollHeight ?? 0;
			const top = scroller?.scrollTop ?? 0;
			try {
				if (props.item.kind === "gap") await props.controller.store.fillGap(props.item.gap);
				else await props.controller.store.loadEarlier();
				await nextTick();
				if (scroller) scroller.scrollTop = top + scroller.scrollHeight - height;
			} catch (error) { toastError(error); } finally { pending.value = false; }
		};
		return () => <button class="btn small transcript-history" type="button" disabled={pending.value} onClick={() => void load()}>
			{pending.value && <span class="spinner" />}<Icon name="refresh" size={13} />{t("transcript.loadEarlier")}</button>;
	},
});

const FailureNotice = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true }, failure: { type: Object as PropType<RunFailure>, required: true } },
	setup(props) {
		const pending = shallowRef(false);
		return () => {
			const failure = props.failure;
			if (failure.reason === "aborted") return <div class="divider"><span>{t("failure.aborted")}</span></div>;
			const label = FAILURE_LABELS[failure.reason];
			return (
				<div class="notice" data-tone="error" data-reason={failure.reason} role="alert">
					<span class="notice-icon"><Icon name="alert" size={16} /></span>
					<div class="notice-body"><div>{label ? t(label) : t("failure.other", failure.reason)}</div>{failure.detail && <div class="notice-detail">{failure.detail}</div>}
						{failure.reason === "no_model" ? <button class="btn small" type="button" onClick={() => props.controller.openModelMenu()}>{t("failure.chooseModel")}</button>
							: <button class="btn small" id="retry" type="button" disabled={pending.value} onClick={() => {
								pending.value = true;
								void props.controller.session.opened.continueQueued(BACKGROUND_CONTEXT).catch((error) => { pending.value = false; toastError(error); });
							}}><Icon name="refresh" size={13} />{t("failure.retry")}</button>}
					</div>
				</div>
			);
		};
	},
});

const RetryNotice = defineComponent({
	props: { retry: { type: Object as PropType<{ at: number; error: string }>, required: true } },
	setup(props) {
		const now = shallowRef(Date.now());
		const timer = setInterval(() => { now.value = Date.now(); }, 1000);
		onBeforeUnmount(() => clearInterval(timer));
		return () => <Notice tone="warn" text={t("live.retry", props.retry.error, Math.max(0, Math.round((props.retry.at - now.value) / 1000)))} />;
	},
});

const EmptyState = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const suggestions: [IconName, string][] = [["eye", t("suggest.summarize")], ["list", t("suggest.links")], ["form", t("suggest.form")]];
		return () => (
			<div class="empty"><div class="empty-logo"><Mascot /></div><h1>{t("empty.title")}</h1>
				{props.controller.store.ready.value ? <div class="suggestions">{suggestions.map(([name, text]) => (
					<button class="suggestion" type="button" onClick={() => void props.controller.send(text)}><span class="suggestion-icon"><Icon name={name} size={16} /></span><span>{text}</span></button>
				))}</div> : <div class="setup"><div class="setup-icon"><Icon name="key" size={18} /></div><strong>{t("empty.setupTitle")}</strong>
					<button class="btn primary" type="button" onClick={() => props.controller.openSettings()}>{t("empty.setupAction")}</button></div>}
			</div>
		);
	},
});

export const Transcript = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const { store } = props.controller;
		const items = shallowRef<readonly TranscriptItem[]>([]);
		const cards = shallowReactive(new Map<string, ToolCard>());
		watch(store.transcript, (view) => { items.value = view ? transcriptItems(view, items.value) : []; }, { immediate: true });
		const syncCards = () => {
			const live = store.live.value;
			const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
			for (const [id, card] of cards) {
				if (card.settled) continue;
				const slot = slots.get(id);
				if (slot) { card.setStatus(slot.status === "done" ? "running" : slot.status); card.setOutput(slot.output); }
				else card.setStatus(store.busy.value ? "pending" : "stopped");
			}
		};
		watch([store.live, items], syncCards, { flush: "post" });
		onMounted(syncCards);
		const row = (item: TranscriptItem) => {
			if (item.kind === "earlier" || item.kind === "gap") return <HistoryButton controller={props.controller} item={item} key={item.key} />;
			if (item.kind === "live") return <AssistantRow controller={props.controller} item={item} cards={cards} syncCards={syncCards} key={item.key} />;
			const entry = item.entry;
			if (entry.kind === "pi.user" || entry.kind === USER_ENTRY) return <UserRow controller={props.controller} entry={entry} key={item.key} />;
			if (entry.kind === "pi.assistant") return <AssistantRow controller={props.controller} item={item} cards={cards} syncCards={syncCards} key={item.key} />;
			if (entry.kind === "pi.tool-result") return <ToolResultRow controller={props.controller} entry={entry} cards={cards} key={item.key} />;
			if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") return <div class="divider" key={item.key}><span>{t(entry.kind === "pi.reset" ? "divider.reset" : "divider.compaction")}</span></div>;
			return null;
		};
		return () => {
			const view = store.transcript.value;
			const live = store.live.value;
			const busy = store.busy.value;
			const empty = !hasVisibleAnswer(items.value) && !busy;
			const running = (live?.tools ?? []).some((slot) => slot.status === "running");
			const partial = items.value.some((item) => item.kind === "live");
			return (
				<div class="thread">
					{view ? items.value.map(row) : store.loaded.value && store.status.value === "new" ? null : <div class="connecting"><span class="spinner" />{t("connecting")}</div>}
					{view && empty && <EmptyState controller={props.controller} />}
					{!view && store.loaded.value && store.status.value === "new" && <EmptyState controller={props.controller} />}
					{busy && !partial && !running && <div class="typing" role="status"><span /><span>{t("thinking.live")}</span></div>}
					{live?.generation?.retry && <RetryNotice retry={live.generation.retry} />}
					{live?.compactions?.length ? <div class="divider" data-live="true"><span>{t("live.compacting")}</span></div> : null}
					{!busy && live?.runFailure && <FailureNotice controller={props.controller} failure={live.runFailure} />}
				</div>
			);
		};
	},
});
