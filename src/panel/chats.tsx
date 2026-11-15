import { computed, defineComponent, nextTick, shallowRef, watch, type PropType } from "vue";
import type { ChatStatus, ChatSummary } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { Icon, Logo, useConfirmation } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { LANG, t } from "./i18n/index.ts";
import { toast, toastError } from "./ui.ts";

const context = BACKGROUND_CONTEXT;
const dayFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(LANG, { hour: "2-digit", minute: "2-digit" });
const when = (ms: number) => {
	const date = new Date(ms);
	return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
};
const statusLabel = (status: ChatStatus) => status === "idle" ? "" : t(`chat.status.${status}`);

const ChatRow = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		summary: { type: Object as PropType<ChatSummary>, required: true }, current: Boolean,
	},
	setup(props) {
		const renaming = shallowRef(false);
		const draft = shallowRef("");
		const composing = shallowRef(false);
		const pending = shallowRef(false);
		const input = shallowRef<HTMLInputElement>();
		const reset = useConfirmation();
		const remove = useConfirmation();
		const title = computed(() => props.summary.title || t("chat.untitled"));
		watch(renaming, async (active) => {
			if (!active) return;
			draft.value = props.summary.title;
			await nextTick();
			input.value?.focus();
			input.value?.select();
		});

		const run = async (action: "reset" | "remove") => {
			const confirmation = action === "reset" ? reset : remove;
			if (pending.value) return;
			if (!confirmation.armed.value) return confirmation.arm();
			pending.value = true;
			confirmation.reset();
			try {
				if (action === "reset") {
					await props.controller.session.with(props.summary.id, (target) => target.reset(context));
					toast(t("chat.resetDone"));
				} else {
					const source = props.controller.workspace;
					if (!source) throw new Error("The workspace is not ready.");
					await source.deleteChat({ id: props.summary.id }, context);
					if (props.current) props.controller.selectChat(undefined);
				}
			} catch (error) { toastError(error); } finally { pending.value = false; }
		};
		const save = async () => {
			if (pending.value || composing.value) return;
			pending.value = true;
			try {
				const source = props.controller.workspace;
				if (!source) throw new Error("The workspace is not ready.");
				if (draft.value.trim() !== props.summary.title) await source.renameChat({ id: props.summary.id, title: draft.value }, context);
				renaming.value = false;
			} catch (error) { toastError(error); } finally { pending.value = false; }
		};
		const actionButton = (action: "reset" | "remove") => {
			const confirmation = action === "reset" ? reset : remove;
			const label = action === "reset"
				? `${t(confirmation.armed.value ? "chat.resetConfirm" : "chat.reset")}: ${title.value}. ${t("chat.resetHint")}`
				: `${t(confirmation.armed.value ? "chat.confirm" : "chat.delete")}: ${title.value}`;
			return (
				<button class={`icon-btn small chat-action ${action}`} type="button" data-action={action} title={label} aria-label={label}
					data-confirm={confirmation.armed.value ? "" : undefined} disabled={pending.value}
					onClick={(event) => { event.stopPropagation(); void run(action); }}>
					{confirmation.armed.value ? t(action === "reset" ? "chat.resetConfirm" : "chat.confirm") : <Icon name={action === "reset" ? "refresh" : "trash"} size={13} />}
				</button>
			);
		};
		return () => {
			const status = statusLabel(props.summary.status);
			const date = new Date(props.summary.updatedAt);
			return (
				<div class={{ "chat-item": true, editing: renaming.value }} role="listitem" data-id={props.summary.id} data-current={props.current ? "true" : undefined}>
					<button class="chat-select" type="button" data-action="select" hidden={renaming.value}
						aria-label={`${title.value}${status ? `, ${status}` : ""}, ${t("chat.lastActive")} ${when(props.summary.updatedAt)}`}
						aria-current={props.current ? "true" : undefined} onClick={() => props.controller.selectChat(props.summary.id)}>
						<span class="chat-title">{title.value}</span>
						<span class="chat-meta">
							{status && <span class="chat-status" data-status={props.summary.status}><span class="chat-status-dot" />{status}</span>}
							<time datetime={date.toISOString()} title={`${t("chat.lastActive")}: ${date.toLocaleString(LANG)}`}>{when(props.summary.updatedAt)}</time>
						</span>
					</button>
					{!renaming.value && <span class="chat-actions">
						<button class="icon-btn small chat-action rename" type="button" data-action="rename" title={t("chat.rename")}
							aria-label={`${t("chat.rename")}: ${title.value}`} disabled={pending.value}
							onClick={(event) => { event.stopPropagation(); reset.reset(); remove.reset(); renaming.value = true; }}><Icon name="compose" size={13} /></button>
						{actionButton("reset")}{actionButton("remove")}
					</span>}
					{renaming.value && (
						<form class="rename-form" tabindex={-1} aria-label={t("chat.rename")} onSubmit={(event) => { event.preventDefault(); void save(); }}>
							<input class="input rename-input" type="text" value={draft.value} maxlength={500} ref={input} disabled={pending.value}
								aria-label={`${t("chat.rename")}: ${title.value}`}
								onInput={(event) => { draft.value = (event.target as HTMLInputElement).value; }}
								onCompositionstart={() => { composing.value = true; }} onCompositionend={() => { composing.value = false; }}
								onKeydown={(event) => {
									if (event.isComposing || event.keyCode === 229 || composing.value) { if (event.key === "Escape") event.stopPropagation(); return; }
									if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); renaming.value = false; }
								}} />
							<span class="chat-actions editing">
								<button class="icon-btn small" type="submit" data-action="save" title={t("chat.renameSave")} aria-label={t("chat.renameSave")} disabled={pending.value}><Icon name="check" size={14} /></button>
								<button class="icon-btn small" type="button" data-action="cancel" title={t("chat.renameCancel")} aria-label={t("chat.renameCancel")}
									disabled={pending.value} onClick={() => { renaming.value = false; }}><Icon name="x" size={14} /></button>
							</span>
						</form>
					)}
				</div>
			);
		};
	},
});

export const ChatDrawer = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const chats = computed(() => [...props.controller.store.chats.value].sort((a, b) => b.updatedAt - a.updatedAt));
		const drawer = shallowRef<HTMLElement>();
		watch(chats, async (next, previous) => {
			const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
			const row = active?.closest<HTMLElement>(".chat-item");
			const id = Number(row?.dataset.id);
			const action = active?.dataset.action ?? (active?.classList.contains("rename-input") ? "rename" : undefined);
			const index = previous.findIndex((chat) => chat.id === id);
			await nextTick();
			if (!drawer.value) return;
			// A keyed move normally preserves focus. If the browser blurred it, restore the same
			// control; if its row disappeared, choose the nearest surviving row instead of body.
			if (document.activeElement !== document.body || !row) return;
			const rows = [...drawer.value!.querySelectorAll<HTMLElement>(".chat-item")];
			const current = rows.find((item) => Number(item.dataset.id) === id);
			const target = current ?? rows[Math.min(Math.max(index, 0), rows.length - 1)];
			const control = action ? target?.querySelector<HTMLElement>(`[data-action="${action}"]`) : undefined;
			(control ?? target?.querySelector<HTMLElement>(".chat-select") ?? drawer.value?.querySelector<HTMLElement>(".panel-head button"))?.focus({ preventScroll: true });
		}, { flush: "pre" });
		return () => (
			<aside class="drawer" id="chat-drawer" role="dialog" aria-modal="true" aria-label={t("chat.list")} ref={drawer}>
				<div class="panel-head"><Logo size={22} /><span class="panel-title">{t("chat.list")}</span>
					<button class="btn small ghost" type="button" onClick={() => props.controller.selectChat(undefined)}><Icon name="plus" size={14} />{t("chat.new")}</button></div>
				<div class="chat-list" role="list">
					{chats.value.length ? chats.value.map((summary) => (
						<ChatRow controller={props.controller} summary={summary} current={summary.id === props.controller.store.id.value} key={summary.id} />
					)) : <div class="list-empty" role="status">{t("chat.none")}</div>}
				</div>
			</aside>
		);
	},
});
