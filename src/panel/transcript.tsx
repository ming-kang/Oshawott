import { defineComponent, nextTick, onBeforeUnmount, onMounted, shallowReactive, shallowRef, watch, type PropType } from "vue";
import type { AssistantMessage, ImageContent, UserMessage } from "@earendil-works/pi-ai";
import { ToolResultEntry, type EntryId, type EntryRecord, type RunFailure, type RunFailureReason } from "@earendil-works/pi-durable";
import { isImageAttachment, type AttachmentRef, USER_ENTRY, userInput } from "../lib/attachments.ts";
import { fromBase64 } from "../lib/base64.ts";
import { formatBytes } from "../lib/bytes.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { AssistantView } from "./assistant-view.ts";
import { Icon, Mascot, NativeView } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { describeError, type ErrorDescription } from "./errors.ts";
import { t } from "./i18n/index.ts";
import { ToolCard, toolLook } from "./tool-card.ts";
import { groupToolRuns, hasVisibleAnswer, transcriptItems, type TranscriptItem } from "./transcript-model.ts";
import { copyButton, download, h, icon, type IconName, toastError } from "./ui.ts";

const FAILURE_LABELS = {
	no_model: "failure.no_model", model_error: "failure.model_error", interrupted: "failure.interrupted", turn_limit: "failure.turn_limit",
	aborted: "failure.aborted", reset: null, faulted: null, orphaned: null, restart_limit: null, nothing_to_answer: null,
} as const satisfies Record<RunFailureReason, string | null>;
const textOf = (content: UserMessage["content"] | Extract<UserMessage["content"][number], { type: "text" }>[]) =>
	typeof content === "string" ? content : content.map((block) => block.type === "text" ? block.text : "").join("");

type ErrorNoticeSpec =
	| { mode: "normal" | "suppressed"; raw: string }
	| { mode: "recovered"; raw: string; raws: readonly string[] }
	| { mode: "retrying"; raw: string; at: number };

const errorRaw = (item: TranscriptItem): string | undefined => {
	if (item.kind !== "entry" || item.entry.kind !== "pi.assistant") return undefined;
	const message = item.entry.model?.[0];
	return message?.role === "assistant" && message.stopReason === "error" ? message.errorMessage : undefined;
};

const errorHeadline = (description: ErrorDescription) => {
	switch (description.kind) {
		case "auth": return t("error.auth");
		case "rate_limit": return t("error.rateLimit");
		case "overloaded": return t("error.overloaded");
		case "bad_request": return t("error.badRequest");
		case "network": return t("error.network");
		case "timeout": return t("error.timeout");
		case "server": return t("error.server", description.status === undefined ? "" : ` (${description.status})`);
		default: return t("failure.model_error");
	}
};

const ErrorNotice = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController> },
		tone: { type: String as PropType<"error" | "warn">, required: true },
		raw: { type: String, required: true },
		raws: { type: Array as PropType<readonly string[]> },
		retryAt: { type: Number },
		retryable: Boolean,
		recovered: Boolean,
		reason: { type: String },
	},
	setup(props) {
		const now = shallowRef(Date.now());
		const pending = shallowRef(false);
		let timer: ReturnType<typeof setInterval> | undefined;
		watch(() => props.retryAt, (at) => {
			if (at !== undefined && timer === undefined) timer = setInterval(() => { now.value = Date.now(); }, 1000);
			else if (at === undefined && timer !== undefined) { clearInterval(timer); timer = undefined; }
		}, { immediate: true });
		onBeforeUnmount(() => clearInterval(timer));
		const raws = () => [...new Set(props.raws?.length ? props.raws : [props.raw])];
		const copy = copyButton(() => raws().join("\n\n"), t("copy"));
		const description = () => describeError(props.raw);
		const headline = () => errorHeadline(description());
		const notice = (tone: "error" | "warn", role: "alert" | "status") => (
			<div class="notice" data-tone={tone} data-reason={props.reason} role={role}>
				<span class="notice-icon"><Icon name="alert" size={16} /></span>
				<div class="notice-body">
					<div class="notice-headline">{headline()}</div>
					{props.retryAt !== undefined && <div class="notice-retry">{t("live.retryIn", Math.max(0, Math.round((props.retryAt - now.value) / 1000)))}</div>}
					{description().summary && <div class="notice-summary">{description().summary}</div>}
					<details class="notice-raw">
						<summary><Icon name="chevron" size={13} />{t("error.showRaw")}</summary>
						<div class="notice-raw-body">
							<div class="notice-raw-head"><NativeView element={copy} /></div>
							{raws().map((part) => <pre>{part}</pre>)}
						</div>
					</details>
					{props.retryable && <button class="btn small" id="retry" type="button" disabled={pending.value} onClick={() => {
						pending.value = true;
						void props.controller?.session.opened.continueQueued(BACKGROUND_CONTEXT).catch((error) => { pending.value = false; toastError(error); });
					}}><Icon name="refresh" size={13} />{t("failure.retry")}</button>}
				</div>
			</div>
		);
		return () => props.recovered ? (
			<details class="notice-recovered">
				<summary><Icon name="alert" size={14} /><span class="notice-recovered-label">{(props.raws?.length ?? 0) > 1 ? t("error.retriedTimes", props.raws!.length) : t("error.recovered")} · {headline()}</span><Icon name="chevron" size={14} /></summary>
				{notice("error", "status")}
			</details>
		) : notice(props.tone, props.tone === "error" ? "alert" : "status");
	},
});

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
		const editing = shallowRef(false);
		const draft = shallowRef("");
		const composing = shallowRef(false);
		const pending = shallowRef(false);
		const area = shallowRef<HTMLTextAreaElement>();
		const resize = () => {
			const element = area.value;
			if (!element) return;
			element.style.height = "auto";
			element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
		};
		watch(editing, async (active) => {
			if (!active) return;
			await nextTick();
			area.value?.focus();
			resize();
		});
		const send = async (attachments: readonly AttachmentRef[]) => {
			if (pending.value || (!draft.value.trim() && !attachments.length)) return;
			pending.value = true;
			try {
				if (await props.controller.fork(props.entry.id, draft.value.trim()) !== undefined) editing.value = false;
			} finally { pending.value = false; }
		};
		return () => {
			const message = props.entry.model?.[0];
			if (message?.role !== "user") return null;
			const { text, attachments } = userInput(props.entry, message.content);
			const images = typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "image");
			let imageIndex = 0;
			const referenced = attachments.map((attachment) => ({ attachment, native: isImageAttachment(attachment) ? images[imageIndex++] : undefined }));
			const disabled = pending.value || props.controller.store.forking.value;
			return (
				<div class={{ "msg user": true, editing: editing.value }}>
					{editing.value ? (
						<div class="user-edit">
							<textarea class="user-edit-text" rows={1} ref={area} value={draft.value} disabled={disabled}
								aria-label={t("msg.edit")} maxlength={1_000_000}
								onInput={(event) => { draft.value = (event.target as HTMLTextAreaElement).value; resize(); }}
								onCompositionstart={() => { composing.value = true; }}
								onCompositionend={() => { composing.value = false; }}
								onKeydown={(event) => {
									if (event.isComposing || event.keyCode === 229 || composing.value) return;
									if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(attachments); }
									else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); editing.value = false; }
								}} />
							{attachments.length > 0 && <div class="user-edit-attachments">
								{attachments.map((attachment) => (
									<span class="queue-attachment" data-path={attachment.path} key={attachment.path}>
										<Icon name={isImageAttachment(attachment) ? "eye" : "file"} size={12} /><span>{attachment.name}</span>
									</span>
								))}
								<span class="user-edit-note">{t("msg.attachmentsKept")}</span>
							</div>}
							<div class="user-edit-hint">{t("msg.branchHint")}</div>
							<div class="user-edit-actions">
								<button class="btn small ghost user-edit-cancel" type="button" disabled={disabled}
									onClick={() => { editing.value = false; }}>{t("settings.cancel")}</button>
								<button class="btn small primary user-edit-send" type="button" disabled={disabled || (!draft.value.trim() && !attachments.length)}
									onClick={() => void send(attachments)}>{t("composer.send")}</button>
							</div>
						</div>
					) : (
						<>
							<div class="bubble">
								{text && <div class="user-text">{text}</div>}
								{referenced.length > 0 && <div class="user-attachments">{referenced.map(({ attachment, native }) => (
									<UserAttachment controller={props.controller} attachment={attachment} native={native} key={attachment.path} />
								))}</div>}
								{images.slice(attachments.filter(isImageAttachment).length).map((image) => <img class="user-image" src={`data:${image.mimeType};base64,${image.data}`} alt={t("attachments.title")} />)}
							</div>
							<div class="msg-actions">
								<NativeView element={copyButton(() => text, t("copy"))} />
								<button class="icon-btn small" data-action="edit" type="button" title={t("msg.edit")} aria-label={t("msg.edit")}
									disabled={props.controller.store.forking.value}
									onClick={() => { draft.value = text; editing.value = true; }}><Icon name="compose" size={14} /></button>
							</div>
						</>
					)}
				</div>
			);
		};
	},
});

const AssistantRow = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true }, item: { type: Object as PropType<TranscriptItem>, required: true },
		cards: { type: Object as PropType<Map<string, ToolCard>>, required: true }, syncCards: { type: Function as PropType<() => void>, required: true },
		notice: { type: Object as PropType<ErrorNoticeSpec> },
		/** The committed user entry this turn answers; absent before the first loaded user entry. */
		forkFrom: Number,
		disabled: Boolean,
	},
	setup(props) {
		const assistant = new AssistantView();
		const registered = new Set<string>();
		watch(() => [props.item, props.forkFrom, props.disabled] as const, ([item]) => {
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
				const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n").trim();
				if (text && !message.content.some((block) => block.type === "toolCall")) {
					const actions = [copyButton(() => text, t("copy"))];
					if (props.forkFrom !== undefined) {
						actions.push(h("button", {
							class: "icon-btn small", type: "button", "data-action": "regenerate",
							title: t("msg.regenerate"), "aria-label": t("msg.regenerate"), disabled: props.disabled,
							onClick: () => void props.controller.fork(props.forkFrom as EntryId),
						}, icon("refresh", 14)));
					}
					assistant.element.append(h("div", { class: "msg-actions" }, actions));
				}
			}
			void nextTick(props.syncCards);
		}, { immediate: true });
		onBeforeUnmount(() => {
			const owned = assistant.cards;
			assistant.dispose();
			for (const id of registered) if (props.cards.get(id) === owned.get(id)) props.cards.delete(id);
		});
		return () => (
			<>
				<NativeView element={assistant.element} />
				{props.notice && props.notice.mode !== "suppressed" && (
					<ErrorNotice controller={props.controller} tone={props.notice.mode === "retrying" ? "warn" : "error"} raw={props.notice.raw}
						raws={props.notice.mode === "recovered" ? props.notice.raws : undefined}
						retryAt={props.notice.mode === "retrying" ? props.notice.at : undefined} recovered={props.notice.mode === "recovered"} />
				)}
			</>
		);
	},
});

const ToolResultRow = defineComponent({
	props: {
		entry: { type: Object as PropType<EntryRecord>, required: true },
		cards: { type: Object as PropType<Map<string, ToolCard>>, required: true },
	},
	setup(props) {
		const message = props.entry.model?.[0];
		if (message?.role !== "toolResult") return () => null;
		const text = textOf(message.content);
		const diagnostics = ToolResultEntry.is(props.entry) ? props.entry.data?.diagnostics : undefined;
		let orphan: ToolCard | undefined;
		const element = h("div", { class: "msg assistant", "data-tools-only": "" }, h("div", { class: "tools" }));
		watch(() => props.cards.get(message.toolCallId), (card) => {
			if (card) card.setResult(text, message.isError, message.details, diagnostics);
			else if (!orphan) {
				orphan = new ToolCard(message.toolName, {});
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
	props: {
		controller: { type: Object as PropType<PanelController>, required: true }, failure: { type: Object as PropType<RunFailure>, required: true },
		raw: { type: String },
	},
	setup(props) {
		const pending = shallowRef(false);
		return () => {
			const failure = props.failure;
			if (failure.reason === "aborted") return <div class="divider"><span>{t("failure.aborted")}</span></div>;
			if (failure.reason === "model_error") {
				const raw = failure.detail && failure.detail !== props.raw ? failure.detail : (props.raw ?? failure.detail ?? "");
				return <ErrorNotice controller={props.controller} tone="error" raw={raw} retryable reason={failure.reason} />;
			}
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
		const runStates = shallowReactive(new Map<string, boolean>());
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
		const row = (item: TranscriptItem, notice?: ErrorNoticeSpec, forkFrom?: EntryId) => {
			if (item.kind === "earlier" || item.kind === "gap") return <HistoryButton controller={props.controller} item={item} key={item.key} />;
			if (item.kind === "live") return <AssistantRow controller={props.controller} item={item} cards={cards} syncCards={syncCards} key={item.key} />;
			const entry = item.entry;
			if (entry.kind === "pi.user" || entry.kind === USER_ENTRY) return <UserRow controller={props.controller} entry={entry} key={item.key} />;
			if (entry.kind === "pi.assistant") return <AssistantRow controller={props.controller} item={item} cards={cards} syncCards={syncCards} notice={notice} forkFrom={forkFrom} disabled={store.forking.value} key={item.key} />;
			if (entry.kind === "pi.tool-result") return <ToolResultRow entry={entry} cards={cards} key={item.key} />;
			if (entry.kind === "pi.reset" || entry.kind === "pi.compaction") return <div class="divider" key={item.key}><span>{t(entry.kind === "pi.reset" ? "divider.reset" : "divider.compaction")}</span></div>;
			return null;
		};
		return () => {
			const view = store.transcript.value;
			const live = store.live.value;
			const busy = store.busy.value;
			const retry = live?.generation?.retry;
			const failure = !busy ? live?.runFailure : undefined;
			const empty = !hasVisibleAnswer(items.value) && !busy;
			const running = (live?.tools ?? []).some((slot) => slot.status === "running");
			const partial = items.value.some((item) => item.kind === "live");
			const committed = items.value.filter((item): item is Extract<TranscriptItem, { kind: "entry" }> => item.kind === "entry");
			const lastCommitted = committed.at(-1);
			const lastError = lastCommitted ? errorRaw(lastCommitted) : undefined;
			const laterAssistant = new Map<TranscriptItem, boolean>();
			let seenAssistant = false;
			for (let index = committed.length - 1; index >= 0; index--) {
				laterAssistant.set(committed[index]!, seenAssistant);
				if (committed[index]!.entry.kind === "pi.assistant") seenAssistant = true;
			}
			const notices = new Map<TranscriptItem, ErrorNoticeSpec>();
			let recoveredGroup: { item: TranscriptItem; raw: string }[] = [];
			const flushGroup = () => {
				const last = recoveredGroup.at(-1);
				if (!last) return;
				notices.set(last.item, { mode: "recovered", raw: last.raw, raws: recoveredGroup.map((entry) => entry.raw) });
				for (const entry of recoveredGroup.slice(0, -1)) notices.set(entry.item, { mode: "suppressed", raw: entry.raw });
				recoveredGroup = [];
			};
			for (const item of items.value) {
				const raw = item.kind === "entry" ? errorRaw(item) : undefined;
				if (raw === undefined) { flushGroup(); continue; }
				if (item === lastCommitted) {
					if (retry) { flushGroup(); notices.set(item, { mode: "retrying", raw, at: retry.at }); continue; }
					if (failure?.reason === "model_error") { flushGroup(); notices.set(item, { mode: "suppressed", raw }); continue; }
				}
				if (laterAssistant.get(item)) recoveredGroup.push({ item, raw });
				else { flushGroup(); notices.set(item, { mode: "normal", raw }); }
			}
			flushGroup();
			// The user entry that started each assistant turn, for regenerate; undefined before the first loaded one.
			const regen = new Map<TranscriptItem, EntryId | undefined>();
			let lastUser: EntryId | undefined;
			for (const item of items.value) {
				if (item.kind !== "entry") continue;
				if (item.entry.kind === "pi.user" || item.entry.kind === USER_ENTRY) lastUser = item.entry.id;
				else if (item.entry.kind === "pi.assistant") regen.set(item, lastUser);
			}
			return (
				<div class="thread">
					{view ? groupToolRuns(items.value, busy).map((entry) => entry.kind === "run" ? (
						<details class="run-fold" key={entry.key} open={runStates.get(entry.key) ?? false}
							onToggle={(event) => { runStates.set(entry.key, (event.currentTarget as HTMLDetailsElement).open); }}>
							<summary>
								<span class="run-fold-icons">{[...new Set(entry.calls.map((call) => call.name))].slice(0, 6).map((name) => <Icon name={toolLook(name, {}).icon} size={13} />)}</span>
								<span class="run-fold-label">{t("run.actions", entry.calls.length)}</span>
								{entry.failures > 0 && <span class="run-fold-failures">{t("run.failed", entry.failures)}</span>}
								<span class="run-fold-chevron"><Icon name="chevron" size={14} /></span>
							</summary>
							<div class="run-fold-body">{entry.items.map((item) => row(item, notices.get(item), regen.get(item)))}</div>
						</details>
					) : row(entry.item, notices.get(entry.item), regen.get(entry.item))) : store.loaded.value && store.status.value === "new" ? null : <div class="connecting"><span class="spinner" />{t("connecting")}</div>}
					{view && empty && <EmptyState controller={props.controller} />}
					{!view && store.loaded.value && store.status.value === "new" && <EmptyState controller={props.controller} />}
					{busy && !partial && !running && !retry && <div class="typing" role="status"><span /><span>{t("thinking.live")}</span></div>}
					{retry && lastError === undefined && <ErrorNotice controller={props.controller} tone="warn" raw={retry.error} retryAt={retry.at} />}
					{live?.compactions?.length ? <div class="divider" data-live="true"><span>{t("live.compacting")}</span></div> : null}
					{failure && <FailureNotice controller={props.controller} failure={failure} raw={failure.reason === "model_error" ? lastError : undefined} />}
				</div>
			);
		};
	},
});
