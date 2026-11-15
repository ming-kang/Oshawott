import { computed, defineComponent, nextTick, shallowRef, watch, type PropType } from "vue";
import type { ChatStatus, ChatSummary } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { groupChats, type ChatGroupKey } from "./chat-groups.ts";
import { Icon, Logo, useConfirmation } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { LANG, t } from "./i18n/index.ts";
import { toast, toastError } from "./ui.ts";

const context = BACKGROUND_CONTEXT;
/** Below this many chats the whole list is in view and a filter is only clutter. */
const SEARCH_THRESHOLD = 8;
const dayFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(LANG, { hour: "2-digit", minute: "2-digit" });
const statusLabel = (status: ChatStatus) => status === "idle" ? "" : t(`chat.status.${status}`);

const ChatRow = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		summary: { type: Object as PropType<ChatSummary>, required: true }, current: Boolean,
		/** Today's rows show a time, older ones a date; `first` rows carry their group's heading. */
		group: { type: String as PropType<ChatGroupKey>, required: true }, first: Boolean, expanded: Boolean,
		onExpand: { type: Function as PropType<(expanded: boolean) => void>, required: true },
	},
	setup(props) {
		const renaming = shallowRef(false);
		const draft = shallowRef("");
		const composing = shallowRef(false);
		const pending = shallowRef(false);
		const input = shallowRef<HTMLInputElement>();
		const row = shallowRef<HTMLElement>();
		const reset = useConfirmation();
		const remove = useConfirmation();
		const title = computed(() => props.summary.title || t("chat.untitled"));
		const focusAction = (action: string) => void nextTick(() => row.value?.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true }));
		watch(renaming, async (active) => {
			if (!active) return;
			draft.value = props.summary.title;
			await nextTick();
			input.value?.focus();
			input.value?.select();
		});
		watch(() => props.expanded, (expanded) => { if (!expanded) { reset.reset(); remove.reset(); } });

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
				focusAction("select");
			} catch (error) { toastError(error); } finally { pending.value = false; }
		};
		const startRename = () => { props.onExpand(false); renaming.value = true; };
		const cancelRename = () => { renaming.value = false; focusAction("select"); };
		const actionButton = (action: "reset" | "remove") => {
			const confirmation = action === "reset" ? reset : remove;
			return (
				<button class={`btn small ghost chat-action ${action}`} type="button" data-action={action}
					title={action === "reset" ? t("chat.resetHint") : undefined}
					data-confirm={confirmation.armed.value ? "" : undefined} disabled={pending.value} onClick={() => void run(action)}>
					<Icon name={action === "reset" ? "refresh" : "trash"} size={13} />
					{t(action === "reset" ? (confirmation.armed.value ? "chat.resetConfirm" : "chat.reset") : (confirmation.armed.value ? "chat.confirm" : "chat.delete"))}
				</button>
			);
		};
		return () => {
			const status = statusLabel(props.summary.status);
			const date = new Date(props.summary.updatedAt);
			const when = (props.group === "today" ? timeFormat : dayFormat).format(date);
			return (
				<div class="chat-entry" role="listitem">
					{props.first && <h3 class="chat-group-head">{t(`chat.group.${props.group}`)}</h3>}
					<div class={{ "chat-item": true, editing: renaming.value }} data-id={props.summary.id} ref={row}
						data-current={props.current ? "true" : undefined} data-expanded={props.expanded ? "" : undefined}
						onKeydown={(event) => {
							if (event.key !== "Escape" || !props.expanded || renaming.value) return;
							event.preventDefault();
							event.stopPropagation();
							props.onExpand(false);
							focusAction("more");
						}}>
						{renaming.value ? (
							<form class="rename-form" tabindex={-1} aria-label={t("chat.rename")} onSubmit={(event) => { event.preventDefault(); void save(); }}>
								<input class="input rename-input" type="text" value={draft.value} maxlength={500} ref={input} disabled={pending.value}
									aria-label={`${t("chat.rename")}: ${title.value}`}
									onInput={(event) => { draft.value = (event.target as HTMLInputElement).value; }}
									onCompositionstart={() => { composing.value = true; }} onCompositionend={() => { composing.value = false; }}
									onKeydown={(event) => {
										if (event.isComposing || event.keyCode === 229 || composing.value) { if (event.key === "Escape") event.stopPropagation(); return; }
										if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelRename(); }
									}} />
								<button class="icon-btn small" type="submit" data-action="save" title={t("chat.renameSave")} aria-label={t("chat.renameSave")} disabled={pending.value}><Icon name="check" size={14} /></button>
								<button class="icon-btn small" type="button" data-action="cancel" title={t("chat.renameCancel")} aria-label={t("chat.renameCancel")}
									disabled={pending.value} onClick={cancelRename}><Icon name="x" size={14} /></button>
							</form>
						) : (
							<div class="chat-row">
								<button class="chat-select" type="button" data-action="select"
									aria-label={`${title.value}${status ? `, ${status}` : ""}, ${t("chat.lastActive")} ${when}`}
									aria-current={props.current ? "true" : undefined} onClick={() => props.controller.selectChat(props.summary.id)}
									onKeydown={(event) => {
										if (event.key === "F2") { event.preventDefault(); startRename(); }
										else if (event.key === "Delete") { event.preventDefault(); props.onExpand(true); focusAction("remove"); }
									}}>
									{status && <span class="chat-status-dot" data-status={props.summary.status} title={status} />}
									<span class="chat-title">{title.value}</span>
								</button>
								<span class="chat-trail">
									<time datetime={date.toISOString()} title={`${t("chat.lastActive")}: ${date.toLocaleString(LANG)}`}>{when}</time>
									<button class="icon-btn small chat-more" type="button" data-action="more" title={t("chat.more")} aria-label={`${t("chat.more")}: ${title.value}`}
										aria-expanded={props.expanded} onClick={() => props.onExpand(!props.expanded)}><Icon name="more" size={16} /></button>
								</span>
							</div>
						)}
						{props.expanded && !renaming.value && (
							<div class="chat-actions" role="group" aria-label={`${t("chat.more")}: ${title.value}`}>
								<button class="btn small ghost chat-action rename" type="button" data-action="rename" disabled={pending.value} onClick={startRename}>
									<Icon name="compose" size={13} />{t("chat.rename")}</button>
								{actionButton("reset")}{actionButton("remove")}
							</div>
						)}
					</div>
				</div>
			);
		};
	},
});

export const ChatDrawer = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const chats = props.controller.store.chats;
		const query = shallowRef("");
		const expanded = shallowRef<number>();
		const searchable = computed(() => chats.value.length >= SEARCH_THRESHOLD);
		watch(searchable, (shown) => { if (!shown) query.value = ""; });
		// One keyed list for every group, so a row that changes group moves instead of being rebuilt.
		const entries = computed(() => groupChats(chats.value, Date.now(), { query: query.value, untitled: t("chat.untitled") })
			.flatMap((group) => group.chats.map((summary, index) => ({ summary, group: group.key, first: index === 0 }))));
		const drawer = shallowRef<HTMLElement>();
		watch(entries, async (_next, previous) => {
			const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
			const row = active?.closest<HTMLElement>(".chat-item");
			const id = Number(row?.dataset.id);
			const action = active?.dataset.action ?? (active?.classList.contains("rename-input") ? "rename" : undefined);
			const index = previous.findIndex((entry) => entry.summary.id === id);
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
				{searchable.value && (
					<label class="chat-search"><Icon name="search" size={14} />
						<input type="search" id="chat-search" placeholder={t("chat.search")} aria-label={t("chat.search")} autocomplete="off" spellcheck="false"
							value={query.value} onInput={(event) => { query.value = (event.target as HTMLInputElement).value; }}
							onKeydown={(event) => {
								if (event.key !== "Escape" || !query.value) return;
								event.preventDefault();
								event.stopPropagation();
								query.value = "";
							}} /></label>
				)}
				<div class="chat-list">
					{entries.value.length ? <div role="list">{entries.value.map(({ summary, group, first }) => (
						<ChatRow controller={props.controller} summary={summary} current={summary.id === props.controller.store.id.value}
							group={group} first={first} expanded={expanded.value === summary.id} key={summary.id}
							onExpand={(open) => { expanded.value = open ? summary.id : expanded.value === summary.id ? undefined : expanded.value; }} />
					))}</div> : <div class="list-empty" role="status">{t(chats.value.length ? "chat.noMatch" : "chat.none")}</div>}
				</div>
			</aside>
		);
	},
});
