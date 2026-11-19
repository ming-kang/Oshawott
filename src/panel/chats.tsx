import { computed, defineComponent, nextTick, shallowRef, watch, type PropType } from "vue";
import type { ChatStatus, ChatSummary } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { groupChats, type ChatGroupKey } from "./chat-groups.ts";
import { Icon, Logo } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { language, t } from "./i18n/index.ts";
import { ChatActionsMenu } from "./menus.tsx";
import { toastError } from "./ui.ts";

const context = BACKGROUND_CONTEXT;
/** Below this many chats the whole list is in view and a filter is only clutter. */
const SEARCH_THRESHOLD = 6;
let dayFormat: Intl.DateTimeFormat | undefined;
let timeFormat: Intl.DateTimeFormat | undefined;
const statusLabel = (status: ChatStatus) => status === "idle" ? "" : t(`chat.status.${status}`);

const ChatRow = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		summary: { type: Object as PropType<ChatSummary>, required: true }, current: Boolean,
		/** Today's rows show a time, older ones a date; `first` rows carry their group's heading. */
		group: { type: String as PropType<ChatGroupKey>, required: true }, first: Boolean,
		/** The active search text; the matching slice of the title is highlighted. */
		query: { type: String, default: "" },
	},
	setup(props) {
		const renaming = shallowRef(false);
		const draft = shallowRef("");
		const composing = shallowRef(false);
		const pending = shallowRef(false);
		const input = shallowRef<HTMLInputElement>();
		const row = shallowRef<HTMLElement>();
		const more = shallowRef<HTMLButtonElement>();
		const title = computed(() => props.summary.title || t("chat.untitled"));
		const menuOpen = computed(() => {
			const active = props.controller.overlays.current.value;
			return active?.id === "chat-actions" && active.anchor === more.value;
		});
		const marked = computed(() => {
			const text = title.value;
			const needle = props.query.trim().toLowerCase();
			const index = needle ? text.toLowerCase().indexOf(needle) : -1;
			if (index < 0) return { head: text, match: "", tail: "" };
			return { head: text.slice(0, index), match: text.slice(index, index + needle.length), tail: text.slice(index + needle.length) };
		});
		const focusAction = (action: string) => void nextTick(() => row.value?.querySelector<HTMLElement>(`[data-action="${action}"]`)?.focus({ preventScroll: true }));
		watch(renaming, async (active) => {
			if (!active) return;
			draft.value = props.summary.title;
			await nextTick();
			input.value?.focus();
			input.value?.select();
		});

		const openMenu = (focus = "") => {
			const overlays = props.controller.overlays;
			const active = overlays.current.value;
			const anchor = more.value;
			if (!anchor) return;
			if (!focus && active?.id === "chat-actions" && active.anchor === anchor) return overlays.close();
			overlays.open({
				id: "chat-actions", kind: "popover", anchor, align: "end", stack: true, component: ChatActionsMenu,
				props: { controller: props.controller, summary: props.summary, current: props.current, onRename: () => { renaming.value = true; }, focus },
			});
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
		const startRename = () => { renaming.value = true; };
		const cancelRename = () => { renaming.value = false; focusAction("select"); };
		return () => {
			const status = statusLabel(props.summary.status);
			const date = new Date(props.summary.updatedAt);
			const format = props.group === "today"
				? timeFormat ??= new Intl.DateTimeFormat(language(), { hour: "2-digit", minute: "2-digit" })
				: dayFormat ??= new Intl.DateTimeFormat(language(), { month: "short", day: "numeric" });
			const when = format.format(date);
			const parts = marked.value;
			return (
				<div class="chat-entry" role="listitem">
					{props.first && <h3 class="chat-group-head">{t(`chat.group.${props.group}`)}</h3>}
					<div class={{ "chat-item": true, editing: renaming.value }} data-id={props.summary.id} ref={row}
						data-current={props.current ? "true" : undefined} data-expanded={menuOpen.value ? "" : undefined}>
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
							<div class="chat-row" onContextmenu={(event) => { event.preventDefault(); openMenu(); }}>
								<button class="chat-select" type="button" data-action="select"
									aria-label={`${title.value}${status ? `, ${status}` : ""}, ${t("chat.lastActive")} ${when}`}
									aria-current={props.current ? "true" : undefined} onClick={() => props.controller.selectChat(props.summary.id)}
									onKeydown={(event) => {
										if (event.key === "F2") { event.preventDefault(); startRename(); }
										else if (event.key === "Delete") { event.preventDefault(); openMenu("remove"); }
									}}>
									{status && <span class="chat-status-dot" data-status={props.summary.status} title={status} />}
									<span class="chat-title">{parts.match ? <>{parts.head}<mark>{parts.match}</mark>{parts.tail}</> : parts.head}</span>
								</button>
								<span class="chat-trail">
									<time datetime={date.toISOString()} title={`${t("chat.lastActive")}: ${date.toLocaleString(language())}`}>{when}</time>
									<button class="icon-btn small chat-more" type="button" data-action="more" title={t("chat.more")} aria-label={`${t("chat.more")}: ${title.value}`}
										aria-haspopup="menu" aria-expanded={menuOpen.value} ref={more} onClick={() => openMenu()}><Icon name="more" size={16} /></button>
								</span>
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
		const searchable = computed(() => chats.value.length >= SEARCH_THRESHOLD);
		watch(searchable, (shown) => { if (!shown) query.value = ""; });
		// One keyed list for every group, so a row that changes group moves instead of being rebuilt.
		const entries = computed(() => groupChats(chats.value, Date.now(), { query: query.value, untitled: t("chat.untitled") })
			.flatMap((group) => group.chats.map((summary, index) => ({ summary, group: group.key, first: index === 0 }))));
		const drawer = shallowRef<HTMLElement>();
		const search = shallowRef<HTMLInputElement>();
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
			<aside class="drawer" id="chat-drawer" role="dialog" aria-modal="true" aria-label={t("chat.list")} ref={drawer}
				onKeydown={(event) => {
					const editable = event.target instanceof HTMLElement && Boolean(event.target.closest("input, textarea, select, [contenteditable='true']"));
					if (editable || !searchable.value) return;
					const find = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey
						|| event.key.toLowerCase() === "f" && (event.ctrlKey || event.metaKey);
					if (!find) return;
					event.preventDefault();
					search.value?.focus();
					search.value?.select();
				}}>
				<div class="panel-head"><Logo size={22} /><span class="panel-title">{t("chat.list")}</span>
					<button class="btn small ghost" type="button" onClick={() => props.controller.selectChat(undefined)}><Icon name="plus" size={14} />{t("chat.new")}</button></div>
				{searchable.value && (
					<label class="chat-search"><Icon name="search" size={14} />
						<input type="search" id="chat-search" placeholder={t("chat.search")} aria-label={t("chat.search")} autocomplete="off" spellcheck="false"
							value={query.value} ref={search} onInput={(event) => { query.value = (event.target as HTMLInputElement).value; }}
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
							group={group} first={first} query={query.value} key={summary.id} />
					))}</div> : <div class="list-empty" role="status">{t(chats.value.length ? "chat.noMatch" : "chat.none")}</div>}
				</div>
			</aside>
		);
	},
});
