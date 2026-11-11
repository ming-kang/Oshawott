import { Chat, DEFAULT_BUSY_MODE, type BusyMode, Workspace } from "../contracts/chat.ts";
import type { AttachmentInput } from "../lib/attachments.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { ApprovalBar } from "./approvals.ts";
import { testAttachmentComposer } from "./selftest/attachments.ts";
import { ChatDrawer } from "./chats.ts";
import { Composer } from "./composer.ts";
import { createPanelHost, engineConnector } from "./connection.ts";
import { DraftSession } from "./draft-session.ts";
import { FilesSheet } from "./files.ts";
import { LANG, t } from "./i18n.ts";
import { ModelMenu } from "./model-menu.ts";
import { supportedThinkingLevels, supportsVision } from "./models.ts";
import { OverlayController } from "./overlays.ts";
import { testPageTools } from "./selftest/page-tools.ts";
import { testPanel } from "./selftest/panel.ts";
import { MessageQueue, SendModeMenu } from "./queue.ts";
import { Transcript } from "./render.ts";
import { selftest } from "./selftest/run.ts";
import { ChatSession, type WorkspaceRef } from "./session.ts";
import { initializeTheme, SettingsSheet } from "./settings.ts";
import { StopControl } from "./stop.ts";
import { TabTracker } from "./tab.ts";
import { testToolCards } from "./selftest/tool-cards.ts";
import { ProviderEditorSheet } from "./provider-editor.ts";
import { ThinkingMenu } from "./thinking-menu.ts";
import { h, icon, toastError } from "./ui.ts";

const context = BACKGROUND_CONTEXT;
const host = createPanelHost();
const session = new ChatSession(host, () => composer.render());
const overlays = new OverlayController();
initializeTheme();
document.documentElement.lang = LANG;

let whenBusy: BusyMode = DEFAULT_BUSY_MODE;
let sending = false;
const queue = new MessageQueue({
	update: async (id, change) => session.opened.updateQueued({ id, ...change }, context),
	cancel: async (id) => session.opened.cancelQueued({ id }, context),
	continue: async () => session.opened.continueQueued(context),
});

const iconButton = (id: string, name: Parameters<typeof icon>[0], label: string) =>
	h("button", { class: "icon-btn", id, type: "button", title: label, "aria-label": label }, icon(name, 18));
const $ = {
	chats: iconButton("chats-toggle", "menu", t("chat.list")),
	title: h("h1", { class: "title", id: "title" }),
	newChat: iconButton("new-chat", "compose", t("chat.new")),
	files: iconButton("files-toggle", "folder", t("files.title")),
	settings: iconButton("settings-toggle", "sliders", t("settings.title")),
	banner: h("div", { class: "banner", role: "status", hidden: true }, h("span", { class: "spinner" }), t("reconnecting")),
	scroller: h("div", { class: "scroller", id: "scroller" }),
	jump: h("button", { class: "jump", type: "button", hidden: true }, icon("down", 14), t("jump")),
};
const connect = engineConnector(host, $.banner);
const tabs = new TabTracker();
const composer = new Composer({
	tabs,
	target: () => session.chat?.target.value ?? null,
	busy: () => transcript.busy,
	ready: () => session.connected.length > 0,
	providers: () => session.providers,
	model: () => session.model,
	thinking: () => session.thinking,
	whenBusy: () => whenBusy,
	configuring: () => session.configuring !== undefined,
	sending: () => sending,
	onSend: () => void send(),
	onStop: (anchor) => stopControl.request(anchor),
	onOpenModelMenu: openModelMenu,
	onOpenThinkingMenu: openThinkingMenu,
	onOpenSendModeMenu: openSendModeMenu,
	onChange: () => drafts.schedule(),
	onRender: closeStaleOverlays,
});
const stopControl = new StopControl({ overlays, queue, composer, chat: () => session.chat, busy: () => transcript.busy });
const drafts = new DraftSession(composer, () => session.id);
const approvals = new ApprovalBar(async (id, decision) => session.opened.decide({ id, decision }, context));
const transcript = new Transcript({
	suggest: (text) => void send(text), openSettings, chooseModel: openModelMenu,
	readFile: async (path) => session.opened.readFile({ path }, context),
	retry: async () => session.opened.continueQueued(context),
	// Granting was the user's answer to the refused call: tell the task so it goes on, instead of making them type it.
	allowed: (site) => void send(t("tool.allowedMessage", site)),
});
$.scroller.append(transcript.element);
document.body.append(
	h("header", { class: "topbar" }, $.chats, $.title, $.newChat, $.files, $.settings),
	h("main", { class: "main" }, $.banner, $.scroller, $.jump),
	h("footer", { class: "composer-wrap" }, approvals.element, queue.element, composer.element),
);

function renderHeader() {
	const summary = session.chats.find((c) => c.id === session.id);
	$.title.textContent = $.title.title = summary?.title || t("chat.untitled");
	$.files.hidden = session.id === undefined;
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
	const value = session.view;
	const ready = session.connected.length > 0;
	queue.update(value);
	approvals.update(session.chat?.approvals.value ?? []);
	if (value) transcript.update({ kind: "conversation", view: value, ready });
	else transcript.update(session.loaded && session.id === undefined ? { kind: "empty", ready } : { kind: "loading" });
	$.files.disabled = !session.chat;
	if (wasBusy && !transcript.busy && overlays.current instanceof FilesSheet) void overlays.refresh();
	if (stick) toBottom();
	else if ($.scroller.scrollHeight > height) $.jump.hidden = false;
	composer.render();
}

/** Closes overlays whose subject the composer no longer shows; runs after every composer render. */
function closeStaleOverlays() {
	if ((!transcript.busy || !composer.hasContent) && overlays.current instanceof SendModeMenu) overlays.close();
	stopControl.sync();
	if ((composer.thinking.hidden || composer.thinking.disabled) && overlays.current instanceof ThinkingMenu) overlays.close();
}

async function open(id: number | undefined, options: { preserveComposer?: boolean; discardPrevious?: boolean; keepOverlays?: boolean } = {}) {
	if (id === session.id && session.loaded && (id === undefined ? drafts.ready : session.chat)) return;
	await drafts.switchTo(id, options, () => {
		if (!options.keepOverlays) overlays.close();
		session.chat?.release();
		session.chat = undefined;
		session.id = id;
		transcript.clear();
		renderHeader();
		renderView();
	});
	if (id === undefined) return;
	const next = await host.get(Chat, { id }, context);
	if (session.id !== id || next.variant !== "owner") return next.release();
	session.chat = next;
	for (const member of [next.view, next.approvals, next.target]) {
		const watch = await member.watch(context);
		watch.start(async () => {
			if (session.chat === next) renderView();
		});
	}
	renderView();
	toBottom();
}

type Origin = { id: number | undefined; revision: number; load: number };

/** Creates the chat for a first message; the composer follows it only if the user is still on the new-chat screen. */
async function createChat(source: WorkspaceRef, raw: string, files: AttachmentInput[], origin: Origin) {
	const created = await source.createChat({}, context);
	if (session.id === undefined && drafts.generation === origin.load) {
		await open(created, { preserveComposer: true });
		origin.load = drafts.generation;
	} else await drafts.adopt(created, { text: raw, attachments: files, updatedAt: Date.now() });
	return created;
}

/** Clears what was sent from the composer and its draft, but only where it still belongs. */
async function settle(id: number, origin: Origin, given: string | undefined, raw: string, files: AttachmentInput[]) {
	const visible = session.id === id && drafts.generation === origin.load;
	// A completion belongs to its originating chat and composer generation, never to whichever chat is visible now.
	if (visible && given === undefined && composer.revision === origin.revision && composer.text === raw) composer.clearText();
	if (visible) composer.attachments.removeSubmitted(files.map((item) => item.id));
	await drafts.submitted(id, raw, files, visible);
	if (visible) toBottom();
}

async function send(given?: string) {
	if (session.configuring) await session.configuring;
	const raw = given ?? composer.text;
	const text = raw.trim();
	const files = composer.pending();
	if ((!text && !files.length) || sending || !session.workspace) return;
	const delivery = whenBusy;
	if (!session.connected.length) {
		if (given) composer.text = given;
		openSettings();
		return;
	}
	sending = true;
	const origin: Origin = { id: session.id, revision: composer.revision, load: drafts.generation };
	composer.render();
	try {
		const configuration = await session.ensureConfiguration();
		if (files.some((item) => item.mimeType.startsWith("image/")) && !supportsVision(session.providers, configuration?.model)) return;
		const id = origin.id ?? await createChat(session.workspace, raw, files, origin);
		await session.with(id, async (target) => {
			const configured = configuration && target === session.chat && session.id === id && session.matches(configuration);
			if (configuration && !configured) await target.configure(configuration, context);
			const tab = tabs.current;
			await target.send({
				text, requestId: crypto.randomUUID(), whenBusy: delivery, attachments: files,
				...(tab && tab.access !== "unavailable" ? { tabId: tab.id } : {}),
			}, context);
		});
		await settle(id, origin, given, raw, files);
	} catch (error) {
		toastError(error);
	} finally {
		sending = false;
		composer.resize();
		composer.render();
	}
}

$.newChat.addEventListener("click", () => { void open(undefined); composer.focus(); });
$.chats.addEventListener("click", openChats);
$.files.addEventListener("click", openFiles);
$.settings.addEventListener("click", openSettings);

function openChats(event?: Event) {
	const anchor = event?.currentTarget instanceof HTMLElement ? event.currentTarget : $.chats;
	overlays.open(new ChatDrawer(() => session.workspace, {
		currentId: () => session.id,
		select: (id) => {
			overlays.close();
			void open(id);
			if (id === undefined) composer.focus();
		},
		reset: (id) => session.with(id, async (target) => { await target.reset(context); }),
	}), { kind: "drawer", anchor });
}
function openFiles() {
	if (session.chat) overlays.open(new FilesSheet(session.chat, () => overlays.close()), { kind: "sheet", anchor: $.files });
}
function openSettings() {
	overlays.open(new SettingsSheet(() => session.workspace, () => overlays.close(), openProviderEditor), { kind: "sheet", anchor: $.settings });
}
function openProviderEditor(provider?: string) {
	overlays.open(new ProviderEditorSheet(provider, () => session.workspace, openSettings), { kind: "sheet", anchor: $.settings });
}
function openSendModeMenu() {
	if (overlays.current instanceof SendModeMenu) return overlays.close();
	const menu = new SendModeMenu(whenBusy, (mode) => {
		whenBusy = mode;
		overlays.close();
		composer.render();
		composer.focus();
	});
	overlays.open(menu, { kind: "popover", anchor: composer.sendMode });
	menu.focus();
}
function openModelMenu() {
	if (session.configuring) return;
	if (overlays.current instanceof ModelMenu) return overlays.close();
	const workspace = session.workspace;
	if (!workspace || !session.connected.length) return openSettings();
	const menu = new ModelMenu(workspace, {
		selected: () => session.model,
		pick: async (ref) => {
			await session.configure({ model: ref, thinkingLevel: session.thinkingFor(ref) });
			if (overlays.current === menu) overlays.close();
		},
	});
	overlays.open(menu, { kind: "popover", anchor: composer.model });
	menu.focus();
}

function openThinkingMenu() {
	if (session.configuring) return;
	if (overlays.current instanceof ThinkingMenu) return overlays.close();
	const model = session.model;
	if (!session.workspace || !model) return;
	const levels = supportedThinkingLevels(session.providers, model);
	if (levels.length < 2) return;
	const menu = new ThinkingMenu(levels, {
		selected: () => session.thinking,
		pick: async (thinkingLevel) => {
			await session.configure({ model, thinkingLevel });
			if (overlays.current === menu) overlays.close();
		},
	});
	overlays.open(menu, { kind: "popover", anchor: composer.thinking, align: "end" });
	menu.focus();
}

async function main() {
	renderHeader();
	renderView();
	tabs.start();
	await connect();
	await host.load([], context);
	const held = await host.get(Workspace, {}, context);
	if (held.variant !== "owner") throw new Error("The Engine refused the panel.");
	session.workspace = held;
	whenBusy = held.busyMode.value;
	let knownChats = new Set(session.chats.map((chat) => chat.id));
	for (const member of [
		held.chats, held.providers, held.logins, held.defaultModel, held.defaultThinkingLevel, held.busyMode,
		held.autoTitle, held.autoCompaction, held.autoRetry, held.confirmActions, held.instructions,
	]) {
		const watch = await member.watch(context);
		watch.start(async () => {
			if (member === held.busyMode) whenBusy = held.busyMode.value;
			if (member === held.chats) {
				const current = new Set(session.chats.map((chat) => chat.id));
				for (const id of knownChats) if (!current.has(id)) await drafts.forget(id);
				if (session.id !== undefined && knownChats.has(session.id) && !current.has(session.id)) await open(undefined, { discardPrevious: true });
				knownChats = current;
			}
			renderHeader();
			if (!(overlays.current instanceof FilesSheet)) void overlays.refresh();
			renderView();
		});
	}
	// An overlay opened before the Workspace arrived has drawn nothing yet, and no change may follow to redraw it.
	void overlays.refresh();
	await drafts.opened();
	session.loaded = true;
	const newest = [...session.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
	await open(newest?.id, { keepOverlays: true });
	renderHeader();
	renderView();
	if (!overlays.current) composer.focus();

	if (__OSHAWOTT_DEV__) {
		const panelTests = (origin?: string) => testPanel(held, origin);
		(globalThis as { __oshawottTest?: unknown }).__oshawottTest = { toolCards: testToolCards, panel: panelTests, attachments: testAttachmentComposer, pageTools: testPageTools };
		const origin = new URLSearchParams(location.search).get("selftest");
		if (origin) void selftest(origin, panelTests);
	}
}
void main();
