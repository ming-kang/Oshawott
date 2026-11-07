// Panel controller: connection, current chat, transcript and composer. Drawers, sheets and menus own their content.
import type { AgentState, ConversationView } from "@earendil-works/pi-durable";
import { Chat, type ModelRef, type ProviderSummary, Workspace } from "../contracts/chat.ts";
import { MESSAGES, PORTS, type Principal } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost, type Reference } from "../lib/chord.ts";
import { portLink } from "../link/port-link.ts";
import "../platform/target.ts";
import { ext } from "../platform/webext.ts";
import { ChatDrawer } from "./chats.ts";
import { FilesSheet } from "./files.ts";
import { LANG, t } from "./i18n.ts";
import { ModelMenu } from "./model-menu.ts";
import { configuredProviders, modelName, sameModel, shownModel as resolveModel } from "./models.ts";
import { OverlayController } from "./overlays.ts";
import { testPanel } from "./panel-selftest.ts";
import { Transcript } from "./render.ts";
import { selftest } from "./selftest.ts";
import { initializeTheme, SettingsSheet } from "./settings.ts";
import { TabTracker, type TargetTab } from "./tab.ts";
import { testToolCards } from "./tool-selftest.ts";
import { h, icon, toast } from "./ui.ts";

type WorkspaceRef = Extract<Reference<typeof Workspace>, { variant: "owner" }>;
type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;
const context = BACKGROUND_CONTEXT;
const host = createHost<Principal>({ onError: (error) => console.debug("[oshawatt panel]", error) });
const overlays = new OverlayController();
initializeTheme();
document.documentElement.lang = LANG;

// ── Shell ──

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
	stop: h("button", { class: "send-btn stop-btn", id: "stop", type: "button", title: t("composer.stop"), "aria-label": t("composer.stop"), hidden: true }, icon("stop", 16)),
	send: h("button", { class: "send-btn", id: "send", type: "button" }),
};
document.body.append(
	h("header", { class: "topbar" }, $.chats, $.title, $.newChat, $.files, $.settings),
	h("main", { class: "main" }, $.banner, $.scroller, $.jump),
	h("footer", { class: "composer-wrap" },
		h("div", { class: "composer", id: "composer" }, $.context, $.prompt, h("div", { class: "composer-bar" }, $.model, $.stop, $.send))),
);

// ── State ──

let workspace: WorkspaceRef | undefined;
let chat: ChatRef | undefined;
/** Undefined for a new chat, created when its first message is sent. */
let chatId: number | undefined;
let loaded = false;
const tabs = new TabTracker();
const transcript = new Transcript({ suggest: (text) => void send(text), openSettings, chooseModel: openModelMenu });
$.scroller.append(transcript.element);
const providers = (): readonly ProviderSummary[] => workspace?.providers.value ?? [];
const connected = () => configuredProviders(providers());
const chats = () => workspace?.chats.value ?? [];
const view = (): ConversationView | null => loaded && chatId !== undefined ? chat?.view.value ?? null : null;
const chatModel = () => (view()?.docs["pi.agent"] as AgentState | undefined)?.model;
const currentModel = (): ModelRef | undefined => chatModel() ?? workspace?.defaultModel.value ?? undefined;
const shownModel = () => resolveModel(providers(), currentModel());

// ── Connection ──

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

// ── Rendering ──

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
	document.body.toggleAttribute("data-scrolled", $.scroller.scrollTop > 2);
});
$.jump.addEventListener("click", () => toBottom(true));

function renderView() {
	const stick = nearBottom();
	const height = $.scroller.scrollHeight;
	const wasBusy = transcript.busy;
	const value = view();
	const ready = connected().length > 0;
	if (value) transcript.update({ kind: "conversation", view: value, ready });
	else transcript.update(loaded && chatId === undefined ? { kind: "empty", ready } : { kind: "loading" });
	$.files.disabled = !chat;
	if (wasBusy && !transcript.busy && overlays.current instanceof FilesSheet) void overlays.refresh();
	if (stick) toBottom();
	else if ($.scroller.scrollHeight > height) $.jump.hidden = false;
	renderComposer();
}

function renderComposer() {
	const busy = transcript.busy;
	const text = $.prompt.value.trim();
	const stop = busy && !text;
	const ref = shownModel();
	const ready = connected().length > 0;
	document.body.dataset.busy = String(busy);
	$.prompt.placeholder = busy ? t("composer.placeholderBusy") : t("composer.placeholder");
	$.stop.hidden = !busy || !text;
	const mode = stop ? "stop" : "send";
	if ($.send.dataset.mode !== mode) {
		$.send.dataset.mode = mode;
		$.send.replaceChildren(icon(stop ? "stop" : "send", 16));
	}
	$.send.disabled = !stop && !text;
	$.send.title = stop ? t("composer.stop") : `${t("composer.send")} (Enter)`;
	$.send.setAttribute("aria-label", stop ? t("composer.stop") : t("composer.send"));
	const label = !ready ? t("model.connect") : ref ? modelName(providers(), ref) : t("model.choose");
	// Compare the actual presentation, not a second cache requiring manual invalidation after a model change.
	if ($.model.dataset.attention !== String(!ready) || $.model.querySelector(".model-name")?.textContent !== label) {
		$.model.dataset.attention = String(!ready);
		$.model.replaceChildren(icon(ready ? "spark" : "key", 14), h("span", { class: "model-name" }, label), icon("chevron", 12));
	}
}

function renderContext(tab: TargetTab | undefined) {
	if (!tab) {
		$.context.replaceChildren(h("span", { class: "tab-chip", "data-access": "unavailable" }, icon("globe", 13), h("span", { class: "name" }, t("tab.none"))));
		return;
	}
	const favicon = tab.favIconUrl ? h("img", { src: tab.favIconUrl, alt: "", width: 14, height: 14, referrerpolicy: "no-referrer" }) : icon("globe", 13);
	if (favicon instanceof HTMLImageElement) favicon.addEventListener("error", () => favicon.replaceWith(icon("globe", 13)), { once: true });
	const access = tab.access === "granted" ? "check" : tab.access === "unavailable" ? "alert" : undefined;
	const accessLabel = tab.access === "granted" ? t("tab.granted") : t("tab.unavailable");
	const chip = h("span", { class: "tab-chip", id: "tab-chip", "data-access": tab.access, title: tab.access === "unavailable" ? t("tab.unavailable") : tab.url },
		favicon, h("span", { class: "name" }, tab.title),
		access ? h("span", { class: "tab-access", title: accessLabel }, icon(access, 12), h("span", { class: "sr-only" }, accessLabel)) : null);
	const extra = tab.access === "grantable"
		? h("button", { class: "grant-btn", id: "grant", type: "button", onclick: grant }, icon("lock", 12), t("tab.grant")) : null;
	$.context.replaceChildren(chip, ...(extra ? [extra] : []));
}
function grant() {
	// No await before the permission request: Firefox requires the click's user gesture.
	void tabs.grant().then((granted) => toast(granted ? t("tab.granted") : t("tab.denied"), granted ? "info" : "error"));
}

// ── Current chat and submissions ──

async function open(id: number | undefined) {
	if (id === chatId && loaded && (id === undefined || chat)) return;
	overlays.close();
	chat?.release();
	chat = undefined;
	chatId = id;
	transcript.clear();
	renderHeader();
	renderView();
	if (id === undefined) return;
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
		await target.send({
			text, requestId: crypto.randomUUID(),
			...(tab && tab.access !== "unavailable" ? { tabId: tab.id } : {}),
			...(transcript.busy ? { whenBusy: "steer" as const } : {}),
		}, context);
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
$.prompt.addEventListener("input", () => { autosize(); renderComposer(); });
$.prompt.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
	event.preventDefault();
	void send();
});
$.stop.addEventListener("click", () => void chat?.abort(context));
$.send.addEventListener("click", () => {
	if ($.send.dataset.mode === "stop") void chat?.abort(context);
	else void send();
});
$.newChat.addEventListener("click", () => { void open(undefined); $.prompt.focus(); });
$.chats.addEventListener("click", openChats);
$.title.addEventListener("click", openChats);
$.files.addEventListener("click", openFiles);
$.settings.addEventListener("click", openSettings);
$.model.addEventListener("click", openModelMenu);

// ── Component wiring ──

function openChats(event?: Event) {
	const anchor = event?.currentTarget instanceof HTMLElement ? event.currentTarget : $.chats;
	overlays.open(new ChatDrawer(() => workspace, {
		currentId: () => chatId,
		select: (id) => {
			overlays.close();
			void open(id);
			if (id === undefined) $.prompt.focus();
		},
	}), { kind: "drawer", anchor });
}
function openFiles() {
	if (chat) overlays.open(new FilesSheet(chat, () => overlays.close()), { kind: "sheet", anchor: $.files });
}
function openSettings() {
	overlays.open(new SettingsSheet(() => workspace, () => overlays.close()), { kind: "sheet", anchor: $.settings });
}
function openModelMenu() {
	if (overlays.current instanceof ModelMenu) return overlays.close();
	if (!workspace || !connected().length) return openSettings();
	const menu = new ModelMenu(workspace, {
		selected: shownModel,
		pick: async (ref) => {
			const source = workspace;
			const target = chat;
			overlays.close();
			try {
				await source?.setDefaultModel(ref, context);
				await target?.configure(ref, context);
				renderComposer();
			} catch (error) {
				toast(String((error as Error)?.message ?? error), "error");
			}
		},
	});
	overlays.open(menu, { kind: "popover", anchor: $.model });
	menu.focus();
}

// ── Start ──

async function main() {
	renderHeader();
	renderView();
	tabs.onChange(renderContext);
	tabs.start();
	await connect();
	await host.load([], context);
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
			// These members feed state-backed overlays; files are queried only on open, manual refresh or run-end.
			if (!(overlays.current instanceof FilesSheet)) void overlays.refresh();
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
		const panelTests = () => testPanel(held);
		(globalThis as { __oshawattTest?: unknown }).__oshawattTest = { toolCards: testToolCards, panel: panelTests };
		const origin = new URLSearchParams(location.search).get("selftest");
		if (origin) void selftest(origin, panelTests);
	}
}
void main();
