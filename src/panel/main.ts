import type { AgentState, ConversationView } from "@earendil-works/pi-durable";
import { Chat, type ChatConfiguration, DEFAULT_BUSY_MODE, PANEL_LINK_LIMITS, type BusyMode, type ModelRef, type ProviderSummary, type ThinkingLevel, Workspace } from "../contracts/chat.ts";
import { MESSAGES, PORTS, type Principal } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost, type Reference } from "../lib/chord.ts";
import { portLink } from "../link/port-link.ts";
import { ext } from "../platform/webext.ts";
import { testAttachmentComposer } from "./attachment-selftest.ts";
import { AttachmentPicker, pendingInput } from "./attachments.ts";
import { ChatDrawer } from "./chats.ts";
import { DraftStore, type ComposerDraft } from "./drafts.ts";
import { FilesSheet } from "./files.ts";
import { LANG, t } from "./i18n.ts";
import { ModelMenu } from "./model-menu.ts";
import { clampThinking, configuredProviders, modelName, sameModel, shownModel as resolveModel, supportedThinkingLevels, supportsVision } from "./models.ts";
import { OverlayController } from "./overlays.ts";
import { testPageTools } from "./page-selftest.ts";
import { testPanel } from "./panel-selftest.ts";
import { MessageQueue, SendModeMenu, StopConfirmMenu } from "./queue.ts";
import { Transcript } from "./render.ts";
import { selftest } from "./selftest.ts";
import { initializeTheme, SettingsSheet } from "./settings.ts";
import { TabTracker, type TargetTab } from "./tab.ts";
import { testToolCards } from "./tool-selftest.ts";
import { ProviderEditorSheet } from "./provider-editor.ts";
import { ThinkingMenu } from "./thinking-menu.ts";
import { h, icon, toast } from "./ui.ts";

type WorkspaceRef = Extract<Reference<typeof Workspace>, { variant: "owner" }>;
type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;
const context = BACKGROUND_CONTEXT;
const host = createHost<Principal>({ onError: (error) => console.debug("[oshawott panel]", error) });
const overlays = new OverlayController();
initializeTheme();
document.documentElement.lang = LANG;

let workspace: WorkspaceRef | undefined;
let chat: ChatRef | undefined;
let chatId: number | undefined;
let loaded = false;
let whenBusy: BusyMode = DEFAULT_BUSY_MODE;
const draftStorePromise = DraftStore.open();
let draftReady = false;
let draftLoad = 0;
let draftTimer: ReturnType<typeof setTimeout> | undefined;
let draftWrites: Promise<void> = Promise.resolve();
let composerRevision = 0;
const queue = new MessageQueue({
	update: async (id, change) => {
		if (!chat) throw new Error("The chat is not open.");
		return chat.updateQueued({ id, ...change }, context);
	},
	cancel: async (id) => {
		if (!chat) throw new Error("The chat is not open.");
		return chat.cancelQueued({ id }, context);
	},
	continue: async () => {
		if (!chat) throw new Error("The chat is not open.");
		return chat.continueQueued(context);
	},
});

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
	vision: h("div", { class: "composer-notice", id: "vision-warning", role: "alert", hidden: true }),
	prompt: h("textarea", { id: "prompt", rows: 1, placeholder: t("composer.placeholder"), "aria-label": t("composer.placeholder") }),
	model: h("button", { class: "model-btn", id: "model", type: "button", "aria-haspopup": "listbox" }),
	thinking: h("button", { class: "model-btn thinking-btn", id: "thinking", type: "button", "aria-haspopup": "listbox" }),
	stop: h("button", { class: "send-btn stop-btn", id: "stop", type: "button", title: t("composer.stop"), "aria-label": t("composer.stop"), hidden: true }, icon("stop", 16)),
	sendMode: h("button", { class: "send-mode-btn", id: "send-mode", type: "button", "aria-haspopup": "menu", hidden: true }),
	send: h("button", { class: "send-btn", id: "send", type: "button" }),
};
const attachments = new AttachmentPicker(() => {
	composerRevision++;
	renderComposer();
	scheduleDraftSave();
});
const composerElement = h("div", { class: "composer", id: "composer", "data-drop-label": t("attachments.drop") },
	$.context, $.vision, attachments.tray, $.prompt, attachments.input,
	h("div", { class: "composer-bar" }, $.model, $.thinking, attachments.button, $.stop, $.sendMode, $.send));
document.body.append(
	h("header", { class: "topbar" }, $.chats, $.title, $.newChat, $.files, $.settings),
	h("main", { class: "main" }, $.banner, $.scroller, $.jump),
	h("footer", { class: "composer-wrap" }, queue.element, composerElement),
);
const tabs = new TabTracker();
const transcript = new Transcript({
	suggest: (text) => void send(text), openSettings, chooseModel: openModelMenu,
	readFile: async (path) => {
		if (!chat) throw new Error("The chat is not open.");
		return chat.readFile({ path }, context);
	},
});
$.scroller.append(transcript.element);
const providers = (): readonly ProviderSummary[] => workspace?.providers.value ?? [];
const connected = () => configuredProviders(providers());
const chats = () => workspace?.chats.value ?? [];
const view = (): ConversationView | null => loaded && chatId !== undefined ? chat?.view.value ?? null : null;
const chatAgent = () => view()?.docs["pi.agent"] as AgentState | undefined;
const chatModel = () => chatAgent()?.model;
const currentModel = (): ModelRef | undefined => chatModel() ?? workspace?.defaultModel.value ?? undefined;
const shownModel = () => resolveModel(providers(), currentModel());
const currentThinking = (): ThinkingLevel => chatId === undefined ? workspace?.defaultThinkingLevel.value ?? "off" : chatAgent()?.thinkingLevel ?? "off";
const shownThinking = () => clampThinking(supportedThinkingLevels(providers(), shownModel()), currentThinking());
const shownConfiguration = (): ChatConfiguration | undefined => {
	const model = shownModel();
	return model ? { model, thinkingLevel: shownThinking() } : undefined;
};

function draftSnapshot(): ComposerDraft {
	return { text: $.prompt.value, attachments: attachments.items.map(pendingInput), updatedAt: Date.now() };
}

function writeDraft(id: number | undefined, snapshot: ComposerDraft) {
	draftWrites = draftWrites.then(async () => (await draftStorePromise).save(id, snapshot)).catch((error) => console.debug("[oshawott draft]", error));
	return draftWrites;
}

function saveDraftNow(id: number | undefined = chatId) {
	if (draftTimer !== undefined) clearTimeout(draftTimer);
	draftTimer = undefined;
	return writeDraft(id, draftSnapshot());
}

function scheduleDraftSave() {
	if (!draftReady) return;
	if (draftTimer !== undefined) clearTimeout(draftTimer);
	const id = chatId;
	const snapshot = draftSnapshot();
	draftTimer = setTimeout(() => {
		draftTimer = undefined;
		void writeDraft(id, snapshot);
	}, 180);
}

async function restoreDraft(id: number | undefined, load: number) {
	const revision = composerRevision;
	const store = await draftStorePromise;
	const draft = await store.load(id).catch(() => undefined);
	if (load !== draftLoad || chatId !== id) return;
	if (revision !== composerRevision) {
		// A slow database read must never overwrite text or imports that arrived meanwhile.
		draftReady = true;
		scheduleDraftSave();
		return;
	}
	$.prompt.value = draft?.text ?? "";
	attachments.restore(draft?.attachments ?? []);
	draftReady = true;
	autosize();
	renderComposer();
}

let backoff = 250;
async function connect() {
	try {
		await ext.runtime.sendMessage({ type: MESSAGES.ensureEngine });
	} catch {
	}
	const link = portLink(ext.runtime.connect({ name: PORTS.panel }), () => ext.runtime.lastError?.message);
	host.connect(link, { principal: { kind: "engine" }, limits: PANEL_LINK_LIMITS }, context);
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
	queue.update(value);
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
	const hasContent = Boolean(text || attachments.items.length);
	const stop = busy && !hasContent;
	const ref = shownModel();
	const ready = connected().length > 0;
	document.body.dataset.busy = String(busy);
	$.prompt.placeholder = busy ? t("composer.placeholderBusy") : t("composer.placeholder");
	$.stop.hidden = !busy || !hasContent;
	$.sendMode.hidden = !busy || !hasContent;
	if ((!busy || !hasContent) && overlays.current instanceof SendModeMenu) overlays.close();
	if (overlays.current instanceof StopConfirmMenu && stopConfirm?.menu === overlays.current) {
		// The confirmation names this run's queue size; it is stale once the run ends, the chat or count changes, or its Stop control goes away.
		const anchorShown = stopConfirm.anchor === $.send ? stop : !$.stop.hidden;
		if (!busy || stopConfirm.chat !== chat || !anchorShown || queue.count !== stopConfirm.count) {
			// Its anchor may now be hidden; return focus to the prompt only if the confirmation held it.
			const focused = stopConfirm.menu.element.contains(document.activeElement);
			overlays.close(false);
			if (focused) $.prompt.focus({ preventScroll: true });
		}
	}
	const deliveryLabel = t(whenBusy === "steer" ? "queue.steer" : "queue.followUp");
	if ($.sendMode.dataset.mode !== whenBusy) {
		$.sendMode.dataset.mode = whenBusy;
		$.sendMode.replaceChildren(h("span", null, deliveryLabel), icon("chevron", 11));
	}
	$.sendMode.title = t("composer.delivery");
	$.sendMode.setAttribute("aria-label", `${t("composer.delivery")}: ${deliveryLabel}`);
	const mode = stop ? "stop" : "send";
	if ($.send.dataset.mode !== mode) {
		$.send.dataset.mode = mode;
		$.send.replaceChildren(icon(stop ? "stop" : "send", 16));
	}
	$.send.disabled = sending || (!stop && !hasContent);
	$.send.title = stop ? t("composer.stop") : busy ? t("composer.sendBusy", deliveryLabel) : `${t("composer.send")} (Enter)`;
	$.send.setAttribute("aria-label", stop ? t("composer.stop") : busy ? deliveryLabel : t("composer.send"));
	const visionBlocked = attachments.hasImages && !supportsVision(providers(), ref);
	$.vision.hidden = !visionBlocked;
	if (visionBlocked) {
		$.vision.replaceChildren(icon("alert", 15), h("span", null, t("composer.vision", ref ? modelName(providers(), ref) : t("model.choose"))),
			h("button", { class: "btn small", type: "button", onclick: openModelMenu }, t("failure.chooseModel")));
	}
	const label = !ready ? t("model.connect") : ref ? modelName(providers(), ref) : t("model.choose");
	if ($.model.dataset.attention !== String(!ready) || $.model.querySelector(".model-name")?.textContent !== label) {
		$.model.dataset.attention = String(!ready);
		$.model.replaceChildren(icon(ready ? "spark" : "key", 14), h("span", { class: "model-name" }, label), icon("chevron", 12));
	}
	const thinking = shownThinking();
	const thinkingLevels = supportedThinkingLevels(providers(), ref);
	$.thinking.hidden = !ready || !ref;
	$.thinking.disabled = configurationTask !== undefined || thinkingLevels.length < 2;
	$.model.disabled = configurationTask !== undefined;
	const thinkingLabel = t(`thinking.level.${thinking}`);
	$.thinking.dataset.level = thinking;
	if ($.thinking.querySelector(".model-name")?.textContent !== thinkingLabel) {
		$.thinking.replaceChildren(icon("bulb", 14), h("span", { class: "model-name" }, thinkingLabel), ...(thinkingLevels.length > 1 ? [icon("chevron", 12)] : []));
	}
	$.thinking.title = `${t("thinking.title")}: ${thinkingLabel}`;
	$.thinking.setAttribute("aria-label", $.thinking.title);
	if (($.thinking.hidden || $.thinking.disabled) && overlays.current instanceof ThinkingMenu) overlays.close();
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

async function open(id: number | undefined, options: { preserveComposer?: boolean; discardPrevious?: boolean; keepOverlays?: boolean } = {}) {
	if (id === chatId && loaded && (id === undefined ? draftReady : chat)) return;
	const previous = chatId;
	const previousDraft = draftSnapshot();
	const previousReady = draftReady;
	if (draftTimer !== undefined) clearTimeout(draftTimer);
	draftTimer = undefined;
	const load = ++draftLoad;
	draftReady = false;
	if (!options.preserveComposer) {
		// Invalidate imports and remove A's visible bytes synchronously, before B's asynchronous draft read starts.
		composerRevision++;
		$.prompt.value = "";
		attachments.clear();
	}
	if (!options.keepOverlays) overlays.close();
	if (options.discardPrevious) {
		const writes = draftWrites;
		void (async () => {
			await writes;
			await (await draftStorePromise).remove(previous).catch(() => undefined);
		})();
	} else if ((previousReady || previousDraft.text || previousDraft.attachments.length) && !options.preserveComposer) {
		void writeDraft(previous, previousDraft);
	}
	chat?.release();
	chat = undefined;
	chatId = id;
	transcript.clear();
	renderHeader();
	renderView();
	if (options.preserveComposer) {
		await writeDraft(id, draftSnapshot());
		if (previous !== id) await (await draftStorePromise).remove(previous).catch(() => undefined);
		if (load === draftLoad) draftReady = true;
	} else await restoreDraft(id, load);
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

async function ensureConfiguration(): Promise<ChatConfiguration | undefined> {
	const configuration = shownConfiguration();
	if (configuration && workspace && (!sameModel(configuration.model, currentModel()) || configuration.thinkingLevel !== currentThinking())) {
		await workspace.setDefaultConfiguration(configuration, context);
	}
	return configuration;
}

async function persistSubmittedDraft(id: number, raw: string, submitted: ReturnType<typeof pendingInput>[], visible: boolean) {
	if (visible) return saveDraftNow(id);
	await draftWrites;
	const store = await draftStorePromise;
	const draft = await store.load(id).catch(() => undefined);
	if (!draft) return;
	const ids = new Set(submitted.map((item) => item.id));
	await writeDraft(id, {
		text: draft.text === raw ? "" : draft.text,
		attachments: draft.attachments.filter((item) => !ids.has(item.id)), updatedAt: Date.now(),
	});
}

let sending = false;
let configurationTask: Promise<void> | undefined;
function applyConfiguration(configuration: ChatConfiguration): Promise<void> {
	if (configurationTask) return configurationTask;
	const source = workspace;
	const target = chat;
	const task = (async () => {
		try {
			await source?.setDefaultConfiguration(configuration, context);
			await target?.configure(configuration, context);
		} catch (error) {
			toast(String((error as Error)?.message ?? error), "error");
		}
	})();
	configurationTask = task;
	renderComposer();
	return task.finally(() => {
		if (configurationTask === task) configurationTask = undefined;
		renderComposer();
	});
}

async function send(given?: string) {
	if (configurationTask) await configurationTask;
	const raw = given ?? $.prompt.value;
	const text = raw.trim();
	const submitted = attachments.items.map(pendingInput);
	if ((!text && !submitted.length) || sending || !workspace) return;
	const delivery = whenBusy;
	if (!connected().length) {
		if (given) $.prompt.value = given;
		openSettings();
		return;
	}
	sending = true;
	const originRevision = composerRevision;
	let originLoad = draftLoad;
	let admittedId = chatId;
	let ownedTarget: ChatRef | undefined;
	renderComposer();
	try {
		const configuration = await ensureConfiguration();
		if (submitted.some((item) => item.mimeType.startsWith("image/")) && !supportsVision(providers(), configuration?.model)) {
			renderComposer();
			return;
		}
		if (admittedId === undefined) {
			const created = await workspace.createChat({}, context);
			if (chatId === undefined && draftLoad === originLoad) {
				await open(created, { preserveComposer: true });
				originLoad = draftLoad;
			} else {
				await draftWrites;
				const store = await draftStorePromise;
				const pending = await store.load(undefined).catch(() => undefined);
				await writeDraft(created, pending ?? { text: raw, attachments: submitted, updatedAt: Date.now() });
				if (chatId !== undefined) await store.remove(undefined).catch(() => undefined);
			}
			admittedId = created;
		}
		let target = chatId === admittedId ? chat : undefined;
		if (!target) {
			const held = await host.get(Chat, { id: admittedId }, context);
			if (held.variant !== "owner") {
				held.release();
				throw new Error("The Engine refused the chat.");
			}
			ownedTarget = held;
			target = held;
		}
		const visibleTarget = target === chat && chatId === admittedId;
		const configured = configuration && visibleTarget && sameModel(chatModel(), configuration.model)
			&& (chatAgent()?.thinkingLevel ?? "off") === configuration.thinkingLevel;
		if (configuration && !configured) await target.configure(configuration, context);
		const tab = tabs.current;
		await target.send({
			text, requestId: crypto.randomUUID(), whenBusy: delivery, attachments: submitted,
			...(tab && tab.access !== "unavailable" ? { tabId: tab.id } : {}),
		}, context);
		const visible = chatId === admittedId && draftLoad === originLoad;
		// A completion belongs to its originating chat and composer generation, never to whichever chat is visible now.
		if (visible && given === undefined && composerRevision === originRevision && $.prompt.value === raw) {
			$.prompt.value = "";
			composerRevision++;
		}
		if (visible) attachments.removeSubmitted(submitted.map((item) => item.id));
		await persistSubmittedDraft(admittedId, raw, submitted, visible);
		if (visible) toBottom();
	} catch (error) {
		toast(String((error as Error)?.message ?? error), "error");
	} finally {
		ownedTarget?.release();
		sending = false;
		autosize();
		renderComposer();
	}
}

function autosize() {
	$.prompt.style.height = "auto";
	$.prompt.style.height = `${Math.min($.prompt.scrollHeight, Math.round(innerHeight * 0.4))}px`;
}
$.prompt.addEventListener("input", () => { composerRevision++; autosize(); renderComposer(); scheduleDraftSave(); });
$.prompt.addEventListener("keydown", (event) => {
	if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
	event.preventDefault();
	void send();
});
$.prompt.addEventListener("paste", (event) => {
	const files = [...event.clipboardData?.files ?? []];
	if (!files.length) return;
	event.preventDefault();
	void attachments.addFiles(files);
});
composerElement.addEventListener("dragover", (event) => {
	if (!event.dataTransfer?.types.includes("Files")) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	composerElement.dataset.dragging = "true";
});
composerElement.addEventListener("dragleave", (event) => {
	if (!(event.relatedTarget instanceof Node) || !composerElement.contains(event.relatedTarget)) delete composerElement.dataset.dragging;
});
composerElement.addEventListener("drop", (event) => {
	if (!event.dataTransfer?.files.length) return;
	event.preventDefault();
	delete composerElement.dataset.dragging;
	void attachments.addFiles([...event.dataTransfer.files]);
});
window.addEventListener("pagehide", () => { if (draftReady) void saveDraftNow(); });
let stopConfirm: { menu: StopConfirmMenu; chat: ChatRef; anchor: HTMLElement; count: number } | undefined;
function abort(target: ChatRef) {
	void target.abort(context).catch((error) => toast(String((error as Error)?.message ?? error), "error"));
}
function stop(anchor: HTMLElement) {
	const target = chat;
	if (!target) return;
	if (!queue.count) return abort(target);
	const menu = new StopConfirmMenu(queue.count, () => {
		overlays.close();
		abort(target);
	}, () => overlays.close());
	stopConfirm = { menu, chat: target, anchor, count: queue.count };
	overlays.open(menu, { kind: "popover", anchor });
	menu.focus();
}
$.stop.addEventListener("click", () => stop($.stop));
$.send.addEventListener("click", () => {
	if ($.send.dataset.mode === "stop") stop($.send);
	else void send();
});
$.sendMode.addEventListener("click", openSendModeMenu);
$.newChat.addEventListener("click", () => { void open(undefined); $.prompt.focus(); });
$.chats.addEventListener("click", openChats);
$.title.addEventListener("click", openChats);
$.files.addEventListener("click", openFiles);
$.settings.addEventListener("click", openSettings);
$.model.addEventListener("click", openModelMenu);
$.thinking.addEventListener("click", openThinkingMenu);

async function resetConversation(id: number) {
	let owned: ChatRef | undefined;
	let target = chatId === id ? chat : undefined;
	if (!target) {
		owned = await host.get(Chat, { id }, context);
		if (owned.variant !== "owner") {
			owned.release();
			throw new Error("The Engine refused the chat.");
		}
		target = owned;
	}
	try {
		await target.reset(context);
	} finally {
		owned?.release();
	}
}

function openChats(event?: Event) {
	const anchor = event?.currentTarget instanceof HTMLElement ? event.currentTarget : $.chats;
	overlays.open(new ChatDrawer(() => workspace, {
		currentId: () => chatId,
		select: (id) => {
			overlays.close();
			void open(id);
			if (id === undefined) $.prompt.focus();
		},
		reset: resetConversation,
	}), { kind: "drawer", anchor });
}
function openFiles() {
	if (chat) overlays.open(new FilesSheet(chat, () => overlays.close()), { kind: "sheet", anchor: $.files });
}
function openSettings() {
	overlays.open(new SettingsSheet(() => workspace, () => overlays.close(), openProviderEditor), { kind: "sheet", anchor: $.settings });
}
function openProviderEditor(provider?: string) {
	overlays.open(new ProviderEditorSheet(provider, () => workspace, openSettings), { kind: "sheet", anchor: $.settings });
}
function openSendModeMenu() {
	if (overlays.current instanceof SendModeMenu) return overlays.close();
	const menu = new SendModeMenu(whenBusy, (mode) => {
		whenBusy = mode;
		overlays.close();
		renderComposer();
		$.prompt.focus();
	});
	overlays.open(menu, { kind: "popover", anchor: $.sendMode });
	menu.focus();
}
function openModelMenu() {
	if (configurationTask) return;
	if (overlays.current instanceof ModelMenu) return overlays.close();
	if (!workspace || !connected().length) return openSettings();
	const menu = new ModelMenu(workspace, {
		selected: shownModel,
		pick: async (ref) => {
			const configuration = { model: ref, thinkingLevel: clampThinking(supportedThinkingLevels(providers(), ref), currentThinking()) };
			await applyConfiguration(configuration);
			if (overlays.current === menu) overlays.close();
		},
	});
	overlays.open(menu, { kind: "popover", anchor: $.model });
	menu.focus();
}

function openThinkingMenu() {
	if (configurationTask) return;
	if (overlays.current instanceof ThinkingMenu) return overlays.close();
	const model = shownModel();
	if (!workspace || !model) return;
	const levels = supportedThinkingLevels(providers(), model);
	if (levels.length < 2) return;
	const menu = new ThinkingMenu(levels, {
		selected: shownThinking,
		pick: async (thinkingLevel) => {
			await applyConfiguration({ model, thinkingLevel });
			if (overlays.current === menu) overlays.close();
		},
	});
	overlays.open(menu, { kind: "popover", anchor: $.thinking, align: "end" });
	menu.focus();
}

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
	whenBusy = held.busyMode.value;
	let knownChats = new Set(chats().map((chat) => chat.id));
	for (const member of [
		held.chats, held.providers, held.logins, held.defaultModel, held.defaultThinkingLevel, held.busyMode,
		held.autoTitle, held.autoCompaction, held.autoRetry, held.instructions,
	]) {
		const watch = await member.watch(context);
		watch.start(async () => {
			if (member === held.busyMode) whenBusy = held.busyMode.value;
			if (member === held.chats) {
				const current = new Set(chats().map((chat) => chat.id));
				for (const id of knownChats) if (!current.has(id)) await (await draftStorePromise).remove(id).catch(() => undefined);
				if (chatId !== undefined && knownChats.has(chatId) && !current.has(chatId)) await open(undefined, { discardPrevious: true });
				knownChats = current;
			}
			renderHeader();
			if (!(overlays.current instanceof FilesSheet)) void overlays.refresh();
			renderView();
		});
	}
	await draftStorePromise;
	loaded = true;
	const newest = [...chats()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
	await open(newest?.id, { keepOverlays: true });
	renderHeader();
	renderView();
	if (!overlays.current) $.prompt.focus();

	if (__OSHAWOTT_DEV__) {
		const panelTests = (origin?: string) => testPanel(held, origin);
		(globalThis as { __oshawottTest?: unknown }).__oshawottTest = { toolCards: testToolCards, panel: panelTests, attachments: testAttachmentComposer, pageTools: testPageTools };
		const origin = new URLSearchParams(location.search).get("selftest");
		if (origin) void selftest(origin, panelTests);
	}
}
void main();
