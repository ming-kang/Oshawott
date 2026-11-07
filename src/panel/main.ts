// The panel: the side panel (Chromium) or sidebar (Firefox). A Chord client of the Engine: it holds the workspace and
// the open chat, and renders their state. Every change arrives as a change of a held member; there are no messages
// to handle. When the Engine's document goes away, the references keep their values and come back on the next link.
//
// Layout: a top bar (chats, the chat's title, new chat, settings), the thread, and the composer with the tab the
// prompt is about and the model it goes to. Chats open in a drawer, settings in a sheet, models in a popover.
import type { ConversationView } from "@earendil-works/pi-durable";
import { Chat, Workspace } from "../contracts/chat.ts";
import { MESSAGES, PORTS, type Principal } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost, type Reference } from "../lib/chord.ts";
import { portLink } from "../link/port-link.ts";
import "../platform/target.ts";
import { ext } from "../platform/webext.ts";
import { FilesSheet } from "./files.ts";
import { LANG, t } from "./i18n.ts";
import { EMPTY_VIEW, Transcript } from "./render.ts";
import { selftest } from "./selftest.ts";
import { TabTracker, type TargetTab } from "./tab.ts";
import { testToolCards } from "./tool-selftest.ts";
import { h, icon, logo, toast } from "./ui.ts";

type ModelRef = { provider: string; modelId: string };
type Provider = { id: string; name: string; configured: boolean; models: readonly { id: string; name: string }[] };
type ChatSummary = { id: number; title: string; createdAt: number };
type WorkspaceRef = Extract<Reference<typeof Workspace>, { variant: "owner" }>;
type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;
type Theme = "system" | "light" | "dark";

const context = BACKGROUND_CONTEXT;
const host = createHost<Principal>({ onError: (error) => console.debug("[oshawatt panel]", error) });

// ── Theme ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const THEME_KEY = "oshawatt:theme";
const savedTheme = (): Theme => {
	const value = localStorage.getItem(THEME_KEY);
	return value === "light" || value === "dark" ? value : "system";
};
function applyTheme(theme: Theme) {
	document.documentElement.dataset.theme = theme;
	if (theme === "system") localStorage.removeItem(THEME_KEY);
	else localStorage.setItem(THEME_KEY, theme);
}
applyTheme(savedTheme());
document.documentElement.lang = LANG;

// ── Shell ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const iconButton = (id: string, name: Parameters<typeof icon>[0], label: string) =>
	h("button", { class: "icon-btn", id, type: "button", title: label, "aria-label": label }, icon(name, 18));

const $ = {
	chats: iconButton("chats-toggle", "menu", t("chat.list")),
	title: h("button", { class: "title-btn", id: "title", type: "button" }),
	newChat: iconButton("new-chat", "compose", t("chat.new")),
	files: iconButton("files-toggle", "folder", t("files.title")),
	settings: iconButton("settings-toggle", "sliders", t("settings.title")),
	banner: h("div", { class: "banner", role: "status", hidden: true }, h("span", { class: "spinner" }), t("reconnecting")),
	scroller: h("div", { class: "scroller", id: "scroller" }),
	jump: h("button", { class: "jump", type: "button", hidden: true }, icon("down", 14), t("jump")),
	context: h("div", { class: "context-row", id: "context" }),
	prompt: h("textarea", { id: "prompt", rows: 1, placeholder: t("composer.placeholder"), "aria-label": t("composer.placeholder") }),
	model: h("button", { class: "model-btn", id: "model", type: "button", "aria-haspopup": "listbox" }),
	send: h("button", { class: "send-btn", id: "send", type: "button" }),
};

document.body.append(
	h("header", { class: "topbar" }, $.chats, $.title, $.newChat, $.files, $.settings),
	h("main", { class: "main" }, $.banner, $.scroller, $.jump),
	h(
		"footer",
		{ class: "composer-wrap" },
		h("div", { class: "composer", id: "composer" }, $.context, $.prompt, h("div", { class: "composer-bar" }, $.model, $.send)),
	),
);

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────────

let workspace: WorkspaceRef | undefined;
let chat: ChatRef | undefined;
/** The open chat; `undefined` for a new one, created when its first message is sent. */
let chatId: number | undefined;
let loaded = false;

const tabs = new TabTracker();
const transcript = new Transcript({
	suggest: (text) => void send(text),
	openSettings: () => openSettings(),
	chooseModel: () => openModelMenu(),
});
$.scroller.append(transcript.element);

const providers = (): readonly Provider[] => workspace?.providers.value ?? [];
const connected = () => providers().filter((provider) => provider.configured);
const chats = (): readonly ChatSummary[] => workspace?.chats.value ?? [];
const view = (): ConversationView | null => (!loaded ? null : chatId === undefined ? EMPTY_VIEW : (chat?.view.value ?? null));
const chatModel = () => (view()?.docs["pi.agent"] as { model?: ModelRef } | undefined)?.model;
const currentModel = (): ModelRef | undefined => chatModel() ?? workspace?.defaultModel.value ?? undefined;
/** The model a prompt goes to: the chosen one, else the first model of the first connected provider. */
const shownModel = (): ModelRef | undefined => {
	const ref = currentModel();
	if (ref && connected().some((provider) => provider.id === ref.provider)) return ref;
	const first = connected().find((provider) => provider.models.length > 0);
	return first ? { provider: first.id, modelId: first.models[0]!.id } : ref;
};
const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) => a?.provider === b?.provider && a?.modelId === b?.modelId;
const modelName = (ref: ModelRef) =>
	providers()
		.find((provider) => provider.id === ref.provider)
		?.models.find((model) => model.id === ref.modelId)?.name ?? ref.modelId;

// ── Connection ───────────────────────────────────────────────────────────────────────────────────────────────────────

let backoff = 250;
async function connect() {
	try {
		await ext.runtime.sendMessage({ type: MESSAGES.ensureEngine });
	} catch {
		// The Broker answers once it is up; connecting tells the rest.
	}
	const link = portLink(ext.runtime.connect({ name: PORTS.panel }), () => ext.runtime.lastError?.message);
	host.connect(link, { principal: { kind: "engine" } }, context);
	const healthy = setTimeout(() => {
		backoff = 250;
		$.banner.hidden = true;
	}, 1500);
	void link.done.then(() => {
		clearTimeout(healthy);
		$.banner.hidden = false;
		setTimeout(() => void connect(), backoff);
		backoff = Math.min(backoff * 2, 10_000);
	});
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────────────────────────

function renderHeader() {
	const summary = chats().find((c) => c.id === chatId);
	$.title.replaceChildren(h("span", null, summary?.title || t("chat.untitled")), icon("chevron", 14));
	$.title.title = summary?.title || t("chat.untitled");
	$.files.hidden = chatId === undefined;
}

const nearBottom = () => $.scroller.scrollHeight - $.scroller.scrollTop - $.scroller.clientHeight < 72;
function toBottom(smooth = false) {
	$.scroller.scrollTo({ top: $.scroller.scrollHeight, behavior: smooth ? "smooth" : "auto" });
	$.jump.hidden = true;
}
$.scroller.addEventListener("scroll", () => {
	if (nearBottom()) $.jump.hidden = true;
});
$.jump.addEventListener("click", () => toBottom(true));

function renderView() {
	const stick = nearBottom();
	const height = $.scroller.scrollHeight;
	const wasBusy = transcript.busy;
	transcript.update(view(), { ready: connected().length > 0 });
	$.files.disabled = !chat;
	if (wasBusy && !transcript.busy) void filesSheet?.refresh();
	if (stick) toBottom();
	else if ($.scroller.scrollHeight > height) $.jump.hidden = false;
	renderComposer();
}

let composerKey = "";
function renderComposer() {
	const busy = transcript.busy;
	const text = $.prompt.value.trim();
	const stop = busy && !text;
	const ref = shownModel();
	const ready = connected().length > 0;
	const key = JSON.stringify([busy, stop, !text, ref, ready, providers().length]);
	if (key === composerKey) return;
	composerKey = key;
	document.body.dataset.busy = String(busy);
	$.prompt.placeholder = busy ? t("composer.placeholderBusy") : t("composer.placeholder");
	$.send.dataset.mode = stop ? "stop" : "send";
	$.send.disabled = !stop && !text;
	$.send.title = stop ? t("composer.stop") : `${t("composer.send")} (Enter)`;
	$.send.setAttribute("aria-label", stop ? t("composer.stop") : t("composer.send"));
	$.send.replaceChildren(icon(stop ? "stop" : "send", 16));
	$.model.dataset.attention = String(!ready);
	$.model.replaceChildren(
		icon(ready ? "spark" : "key", 14),
		h("span", { class: "model-name" }, !ready ? t("model.connect") : ref ? modelName(ref) : t("model.choose")),
		icon("chevron", 12),
	);
}

function renderContext(tab: TargetTab | undefined) {
	if (!tab) {
		$.context.replaceChildren(h("span", { class: "tab-chip", "data-access": "unavailable" }, icon("globe", 13), h("span", { class: "name" }, t("tab.none"))));
		return;
	}
	const favicon = tab.favIconUrl ? h("img", { src: tab.favIconUrl, alt: "", width: 14, height: 14, referrerpolicy: "no-referrer" }) : icon("globe", 13);
	if (favicon instanceof HTMLImageElement) favicon.addEventListener("error", () => favicon.replaceWith(icon("globe", 13)), { once: true });
	const chip = h(
		"span",
		{ class: "tab-chip", id: "tab-chip", "data-access": tab.access, title: tab.access === "unavailable" ? t("tab.unavailable") : tab.url },
		favicon,
		h("span", { class: "name" }, tab.title),
	);
	const extra =
		tab.access === "grantable"
			? h("button", { class: "grant-btn", id: "grant", type: "button", onclick: grant }, icon("lock", 12), t("tab.grant"))
			: null;
	$.context.replaceChildren(chip, ...(extra ? [extra] : []));
}

function grant() {
	// Straight from the click: the permission request must be within the gesture.
	void tabs.grant().then((granted) => toast(granted ? t("tab.granted") : t("tab.denied"), granted ? "info" : "error"));
}

// ── Chats ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function open(id: number | undefined) {
	if (id === chatId && loaded && (id === undefined || chat)) return;
	closeOverlay?.();
	chat?.release();
	chat = undefined;
	chatId = id;
	transcript.clear();
	renderHeader();
	renderChatList?.();
	if (id === undefined) {
		renderView();
		return;
	}
	renderView();
	const next = await host.get(Chat, { id }, context);
	if (chatId !== id || next.variant !== "owner") return next.release();
	chat = next;
	const watch = await next.view.watch(context);
	watch.start(async () => {
		if (chat === next) renderView();
	});
	renderView();
	toBottom();
}

/** Makes the shown model the chosen one, when it is only the fallback. */
async function ensureModel(): Promise<ModelRef | undefined> {
	const ref = shownModel();
	if (ref && workspace && !sameModel(ref, currentModel())) await workspace.setDefaultModel(ref, context);
	return ref;
}

let sending = false;
async function send(given?: string) {
	const text = (given ?? $.prompt.value).trim();
	if (!text || sending || !workspace) return;
	if (!connected().length) {
		if (given) $.prompt.value = given;
		openSettings();
		return;
	}
	sending = true;
	$.prompt.value = "";
	autosize();
	try {
		const model = await ensureModel();
		if (chatId === undefined) await open(await workspace.createChat({}, context));
		const target = chat;
		if (!target) throw new Error("The chat did not open.");
		if (model && !sameModel(chatModel(), model)) await target.configure(model, context);
		const tab = tabs.current;
		await target.send(
			{
				text,
				requestId: crypto.randomUUID(),
				...(tab && tab.access !== "unavailable" ? { tabId: tab.id } : {}),
				...(transcript.busy ? { whenBusy: "steer" as const } : {}),
			},
			context,
		);
		toBottom();
	} catch (error) {
		if (!$.prompt.value) $.prompt.value = text;
		toast(String((error as Error)?.message ?? error), "error");
	} finally {
		sending = false;
		autosize();
		renderComposer();
	}
}

function autosize() {
	$.prompt.style.height = "auto";
	$.prompt.style.height = `${Math.min($.prompt.scrollHeight, Math.round(innerHeight * 0.4))}px`;
}

$.prompt.addEventListener("input", () => {
	autosize();
	renderComposer();
});
$.prompt.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
	event.preventDefault();
	void send();
});
$.send.addEventListener("click", () => {
	if ($.send.dataset.mode === "stop") void chat?.abort(context);
	else void send();
});
$.newChat.addEventListener("click", () => {
	void open(undefined);
	$.prompt.focus();
});
$.chats.addEventListener("click", () => openChats());
$.title.addEventListener("click", () => openChats());
$.files.addEventListener("click", () => openFiles());
$.settings.addEventListener("click", () => openSettings());
$.model.addEventListener("click", () => openModelMenu());

// ── Overlays: chats drawer, files and settings sheets ────────────────────────────────────────────────────────────────

let closeOverlay: (() => void) | undefined;
let filesSheet: FilesSheet | undefined;
let renderChatList: (() => void) | undefined;
let renderSettings: (() => void) | undefined;

function overlay(kind: "drawer" | "sheet", panel: HTMLElement, onClose: () => void) {
	closeMenu();
	closeOverlay?.();
	const backdrop = h("div", { class: "backdrop" });
	const root = h("div", { class: `overlay ${kind}-overlay` }, backdrop, panel);
	const close = () => {
		if (closeOverlay !== close) return;
		closeOverlay = undefined;
		onClose();
		root.classList.add("leaving");
		setTimeout(() => root.remove(), 180);
	};
	backdrop.addEventListener("click", close);
	document.body.append(root);
	closeOverlay = close;
	return close;
}

const dayFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(LANG, { hour: "2-digit", minute: "2-digit" });
function when(ms: number) {
	const date = new Date(ms);
	return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
}

function openChats() {
	const list = h("div", { class: "chat-list", role: "list" });
	const fill = () => {
		const items = [...chats()].sort((a, b) => b.createdAt - a.createdAt);
		list.replaceChildren(...(items.length ? items.map(chatItem) : [h("div", { class: "list-empty" }, t("chat.none"))]));
	};
	const close = overlay(
		"drawer",
		h(
			"aside",
			{ class: "drawer", id: "chat-drawer", "aria-label": t("chat.list") },
			h(
				"div",
				{ class: "panel-head" },
				logo(22),
				h("span", { class: "panel-title" }, t("chat.list")),
				h(
					"button",
					{
						class: "btn small primary",
						type: "button",
						onclick: () => {
							close();
							void open(undefined);
							$.prompt.focus();
						},
					},
					icon("plus", 14),
					t("chat.new"),
				),
			),
			list,
		),
		() => (renderChatList = undefined),
	);
	renderChatList = fill;
	fill();
}

function chatItem(summary: ChatSummary) {
	const remove = h("button", { class: "icon-btn small remove", type: "button", title: t("chat.delete"), "aria-label": t("chat.delete") }, icon("trash", 14));
	remove.addEventListener("click", async (event) => {
		event.stopPropagation();
		if (remove.dataset.confirm !== undefined) {
			remove.disabled = true;
			try {
				await workspace?.deleteChat({ id: summary.id }, context);
				if (summary.id === chatId) await open(undefined);
			} catch (error) {
				toast(String((error as Error)?.message ?? error), "error");
			} finally {
				remove.disabled = false;
			}
			return;
		}
		remove.dataset.confirm = "";
		remove.replaceChildren(t("chat.confirm"));
		setTimeout(() => {
			if (!remove.isConnected) return;
			delete remove.dataset.confirm;
			remove.replaceChildren(icon("trash", 14));
		}, 3000);
	});
	return h(
		"div",
		{
			class: "chat-item",
			role: "listitem",
			tabindex: 0,
			"data-id": summary.id,
			"aria-current": summary.id === chatId ? "true" : null,
			onclick: () => {
				closeOverlay?.();
				void open(summary.id);
			},
			onkeydown: (event: KeyboardEvent) => {
				if (event.key === "Enter") (event.currentTarget as HTMLElement).click();
			},
		},
		h("span", { class: "chat-title" }, summary.title || t("chat.untitled")),
		h("time", { datetime: new Date(summary.createdAt).toISOString() }, when(summary.createdAt)),
		remove,
	);
}

function openFiles() {
	if (!chat) return;
	const sheet = new FilesSheet(chat, () => close());
	const close = overlay("sheet", sheet.element, () => {
		sheet.close();
		filesSheet = undefined;
		$.files.focus();
	});
	filesSheet = sheet;
	void sheet.refresh();
}

const MARKS: Record<string, string> = {
	anthropic: "#c96442",
	openai: "#10a37f",
	google: "#3b78e7",
	openrouter: "#6366f1",
	deepseek: "#4d6bfe",
};

function openSettings() {
	let expanded: string | undefined = connected().length ? undefined : providers()[0]?.id;
	const card = h("div", { class: "card providers", id: "providers" });
	const row = (provider: Provider) => {
		const open = expanded === provider.id;
		const input = h("input", {
			class: "input",
			type: "password",
			placeholder: t("settings.keyPlaceholder"),
			autocomplete: "off",
			spellcheck: "false",
			"aria-label": `${provider.name} API key`,
		});
		const save = h("button", { class: "btn primary", type: "button" }, provider.configured ? t("settings.replace") : t("settings.save"));
		save.addEventListener("click", async () => {
			if (!input.value.trim()) return input.focus();
			save.disabled = true;
			try {
				await workspace?.setApiKey({ provider: provider.id, key: input.value }, context);
				expanded = undefined;
				toast(t("settings.saved"));
			} catch (error) {
				toast(String((error as Error)?.message ?? error), "error");
			} finally {
				save.disabled = false;
			}
		});
		input.addEventListener("keydown", (event) => event.key === "Enter" && save.click());
		const remove = provider.configured
			? h(
					"button",
					{
						class: "btn danger",
						type: "button",
						onclick: async () => {
							await workspace?.clearApiKey({ provider: provider.id }, context);
							toast(t("settings.removed"));
						},
					},
					t("settings.remove"),
				)
			: null;
		return h(
			"div",
			{ class: "provider", "data-provider": provider.id, "data-open": open || null },
			h(
				"button",
				{
					class: "provider-head",
					type: "button",
					"aria-expanded": String(open),
					onclick: () => {
						expanded = open ? undefined : provider.id;
						fill();
						if (!open) card.querySelector<HTMLInputElement>(`[data-provider="${provider.id}"] input`)?.focus();
					},
				},
				h("span", { class: "provider-mark", style: `--mark:${MARKS[provider.id] ?? "var(--accent)"}` }, provider.name.slice(0, 1).toUpperCase()),
				h("span", { class: "provider-name" }, provider.name),
				h("span", { class: "pill", "data-on": provider.configured || null }, provider.configured ? t("settings.connected") : t("settings.notSet")),
				icon("chevron", 14),
			),
			open ? h("div", { class: "provider-form" }, input, save, remove) : null,
		);
	};
	const fill = () => card.replaceChildren(...providers().map(row));

	const themes: Theme[] = ["system", "light", "dark"];
	const segmented = h(
		"div",
		{ class: "segmented", role: "radiogroup", "aria-label": t("settings.appearance") },
		themes.map((theme) =>
			h(
				"button",
				{
					type: "button",
					role: "radio",
					"data-value": theme,
					"aria-checked": String(savedTheme() === theme),
					onclick: () => {
						applyTheme(theme);
						for (const button of segmented.querySelectorAll("button")) button.setAttribute("aria-checked", String(button.dataset.value === theme));
					},
				},
				t(`settings.theme.${theme}`),
			),
		),
	);

	const close = overlay(
		"sheet",
		h(
			"section",
			{ class: "sheet", id: "settings", "aria-label": t("settings.title") },
			h(
				"div",
				{ class: "panel-head" },
				h("button", { class: "icon-btn", id: "settings-back", type: "button", "aria-label": t("settings.title"), onclick: () => close() }, icon("back", 18)),
				h("span", { class: "panel-title" }, t("settings.title")),
			),
			h(
				"div",
				{ class: "sheet-body" },
				h(
					"section",
					{ class: "section" },
					h("h3", null, t("settings.providers")),
					card,
					h("p", { class: "section-hint" }, icon("lock", 12), h("span", null, t("settings.providersHint"))),
				),
				h("section", { class: "section" }, h("h3", null, t("settings.appearance")), segmented),
				h(
					"section",
					{ class: "section" },
					h("h3", null, t("settings.about")),
					h(
						"div",
						{ class: "card about" },
						logo(34),
						h("div", null, h("strong", null, "Oshawatt"), h("span", null, t("settings.version", ext.runtime.getManifest().version))),
					),
				),
			),
		),
		() => (renderSettings = undefined),
	);
	renderSettings = fill;
	fill();
}

// ── Model menu ───────────────────────────────────────────────────────────────────────────────────────────────────────

let menu: HTMLElement | undefined;

function closeMenu() {
	menu?.remove();
	menu = undefined;
	$.model.setAttribute("aria-expanded", "false");
	document.removeEventListener("pointerdown", outsideMenu, true);
}

function outsideMenu(event: PointerEvent) {
	const target = event.target as Node;
	if (menu && !menu.contains(target) && !$.model.contains(target)) closeMenu();
}

function openModelMenu() {
	if (menu) return closeMenu();
	if (!connected().length) return openSettings();
	const current = shownModel();
	const search = h("input", { class: "menu-search", type: "search", placeholder: t("model.search"), "aria-label": t("model.search") });
	const list = h("div", { class: "menu-list", role: "listbox" });
	const pick = async (ref: ModelRef) => {
		closeMenu();
		await workspace?.setDefaultModel(ref, context);
		await chat?.configure(ref, context);
		composerKey = "";
		renderComposer();
	};
	const items = () => [...list.querySelectorAll<HTMLButtonElement>(".menu-item")];
	const activate = (item: HTMLButtonElement | undefined) => {
		for (const other of items()) other.classList.toggle("active", other === item);
		item?.scrollIntoView({ block: "nearest" });
	};
	const fill = () => {
		const query = search.value.trim().toLowerCase();
		const groups = connected()
			.map((provider) => ({
				provider,
				models: provider.models.filter((model) => !query || `${model.name} ${model.id}`.toLowerCase().includes(query)),
			}))
			.filter((group) => group.models.length);
		list.replaceChildren(
			...(groups.length
				? groups.flatMap(({ provider, models }) => [
						h("div", { class: "menu-group" }, provider.name),
						...models.map((model) => {
							const selected = current?.provider === provider.id && current.modelId === model.id;
							return h(
								"button",
								{
									class: "menu-item",
									type: "button",
									role: "option",
									"aria-selected": String(selected),
									"data-provider": provider.id,
									"data-model": model.id,
									onclick: () => void pick({ provider: provider.id, modelId: model.id }),
								},
								h("span", { class: "menu-item-name" }, model.name),
								model.name !== model.id ? h("span", { class: "menu-item-id" }, model.id) : null,
								selected ? icon("check", 14) : null,
							);
						}),
					])
				: [h("div", { class: "list-empty" }, t("model.none"))]),
		);
		activate(items().find((item) => item.getAttribute("aria-selected") === "true") ?? items()[0]);
	};
	search.addEventListener("input", fill);
	search.addEventListener("keydown", (event) => {
		const all = items();
		const at = all.findIndex((item) => item.classList.contains("active"));
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			activate(all[Math.max(0, Math.min(all.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))]);
		} else if (event.key === "Enter") {
			event.preventDefault();
			all[at]?.click();
		}
	});
	menu = h("div", { class: "popover", id: "model-menu" }, search, list);
	menu.style.bottom = `${innerHeight - $.model.getBoundingClientRect().top + 8}px`;
	document.body.append(menu);
	$.model.setAttribute("aria-expanded", "true");
	fill();
	search.focus();
	document.addEventListener("pointerdown", outsideMenu, true);
}

document.addEventListener("keydown", (event) => {
	if (event.key !== "Escape") return;
	if (menu) closeMenu();
	else closeOverlay?.();
});

// ── Start ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
	renderHeader();
	renderView();
	tabs.onChange(renderContext);
	tabs.start();
	await connect();
	await host.load([], context);
	// A reference is live once `get` resolves, and stays usable across Engine restarts (it goes `loading`, then back).
	const held = await host.get(Workspace, {}, context);
	if (held.variant !== "owner") throw new Error("The Engine refused the panel.");
	workspace = held;
	let knownChats = new Set(chats().map((chat) => chat.id));
	for (const member of [held.chats, held.providers, held.defaultModel]) {
		const watch = await member.watch(context);
		watch.start(async () => {
			if (member === held.chats) {
				const current = new Set(chats().map((chat) => chat.id));
				if (chatId !== undefined && knownChats.has(chatId) && !current.has(chatId)) await open(undefined);
				knownChats = current;
			}
			renderHeader();
			renderChatList?.();
			renderSettings?.();
			renderView();
		});
	}
	loaded = true;
	const newest = [...chats()].sort((a, b) => b.createdAt - a.createdAt)[0];
	await open(newest?.id);
	renderHeader();
	renderView();
	$.prompt.focus();

	if (__OSHAWATT_DEV__) {
		(globalThis as { __oshawattTest?: unknown }).__oshawattTest = { toolCards: testToolCards };
		const origin = new URLSearchParams(location.search).get("selftest");
		if (origin) void selftest(origin);
	}
}

void main();
