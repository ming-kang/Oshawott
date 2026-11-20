import { shallowRef, watch } from "vue";
import type { EntryId } from "@earendil-works/pi-durable";
import { Workspace } from "../contracts/chat.ts";
import type { AttachmentInput } from "../lib/attachments.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { ext } from "../platform/webext.ts";
import type { TargetTab } from "./tab.ts";
import { ChatDrawer } from "./chats.tsx";
import { ComposerState } from "./composer-state.ts";
import { engineConnector, type PanelHost } from "./connection.ts";
import { DraftSession } from "./draft-session.ts";
import { FilesSheet } from "./files.tsx";
import { ModelMenu, SendModeMenu, StopConfirmMenu, ThinkingMenu } from "./menus.tsx";
import { Overlays } from "./overlay.ts";
import { ProviderEditorSheet } from "./provider-editor.tsx";
import { ChatSession, type WorkspaceRef } from "./session.ts";
import { SettingsSheet } from "./settings.tsx";
import { PanelStore } from "./store.ts";
import { TabTracker } from "./tab.ts";
import { supportedThinkingLevels, supportsVision } from "./models.ts";
import { t } from "./i18n/index.ts";
import { toast, toastError } from "./ui.ts";

const context = BACKGROUND_CONTEXT;
type Origin = { id: number | undefined; revision: number; load: number };

/** Coordinates durable operations and local UI lifecycles; components only render and issue intents. */
export class PanelController {
	readonly host: PanelHost;
	readonly session: ChatSession;
	readonly store: PanelStore;
	readonly composer: ComposerState;
	readonly drafts: DraftSession;
	readonly overlays = new Overlays();
	readonly tabs = new TabTracker();
	readonly tab = shallowRef<TargetTab>();
	readonly chatsButton = shallowRef<HTMLButtonElement>();
	readonly filesButton = shallowRef<HTMLButtonElement>();
	readonly settingsButton = shallowRef<HTMLButtonElement>();
	readonly scroller = shallowRef<HTMLElement>();
	readonly scrollToBottom = shallowRef<(smooth?: boolean) => void>();
	#viewFrame: number | undefined;
	#siteAccessGranted = false;
	#refreshSiteAccess = () => ext.permissions.contains({ origins: ["<all_urls>"] }).then((granted) => {
		this.#siteAccessGranted = granted;
	}).catch(() => {});
	#stop: { chat: ChatSession["chat"]; count: number } | undefined;

	constructor(host: PanelHost) {
		this.host = host;
		this.session = new ChatSession(host, () => this.#scheduleView());
		this.store = new PanelStore(this.session);
		this.composer = new ComposerState(() => this.drafts.schedule());
		this.drafts = new DraftSession(this.composer, () => this.session.id);
		this.tabs.onChange((tab) => { this.tab.value = tab; });
		watch([this.store.busy, this.composer.hasContent], ([busy, content]) => {
			if (!busy || !content) this.overlays.closeIf("send-mode");
			this.#syncStop();
		});
		watch([this.store.queue, this.store.id, this.store.busy], () => this.#syncStop());
		watch([this.store.model, this.store.thinking, this.store.providers, this.store.ready], () => {
			if (this.overlays.current.value?.id !== "thinking") return;
			const levels = supportedThinkingLevels(this.store.providers.value, this.store.model.value);
			if (!this.store.ready.value || !this.store.model.value || levels.length < 2) this.overlays.close();
		});
	}

	get workspace() { return this.session.workspace; }

	#scheduleView() {
		this.#viewFrame ??= requestAnimationFrame(() => {
			this.#viewFrame = undefined;
			this.store.publishView();
		});
	}

	async start() {
		ext.permissions.onAdded.addListener(this.#refreshSiteAccess);
		ext.permissions.onRemoved.addListener(this.#refreshSiteAccess);
		await this.#refreshSiteAccess();
		this.tabs.start();
		await engineConnector(this.host, (reconnecting) => { this.store.reconnecting.value = reconnecting; })();
		await this.host.load([], context);
		const held = await this.host.get(Workspace, {}, context);
		if (held.variant !== "owner") throw new Error("The Engine refused the panel.");
		this.session.attachWorkspace(held);
		await this.store.attachWorkspace(held, async (previous, next) => {
			const current = new Set(next.map((chat) => chat.id));
			const removed = previous.filter((chat) => !current.has(chat.id));
			for (const { id } of removed) await this.drafts.forget(id);
			if (removed.some((chat) => chat.id === this.session.id)) await this.open(undefined, { discardPrevious: true });
		});
		await this.drafts.opened();
		this.session.markLoaded();
		const newest = [...this.session.chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
		await this.open(newest?.id, { keepOverlays: true });
		if (!this.overlays.current.value) this.composer.focus();
		return held;
	}

	async open(id: number | undefined, options: { preserveComposer?: boolean; discardPrevious?: boolean; keepOverlays?: boolean } = {}) {
		if (id === this.session.id && this.session.loaded && (id === undefined ? this.drafts.ready : this.session.chat)) return;
		await this.session.open(id, (commit) => this.drafts.switchTo(id, options, () => {
			if (!options.keepOverlays) this.overlays.close();
			commit();
			this.store.beginConversation(id);
			this.store.publishView();
		}));
		this.store.publishView();
	}

	async createChat(source: WorkspaceRef, raw: string, files: AttachmentInput[], origin: Origin) {
		const created = await source.createChat({}, context);
		if (this.session.id === undefined && this.drafts.generation === origin.load) {
			await this.open(created, { preserveComposer: true });
			origin.load = this.drafts.generation;
		} else await this.drafts.adopt(created, { text: raw, attachments: files, updatedAt: Date.now() });
		return created;
	}

	async settle(id: number, origin: Origin, given: string | undefined, raw: string, files: AttachmentInput[]) {
		const visible = this.session.id === id && this.drafts.generation === origin.load;
		if (visible && given === undefined && this.composer.revision === origin.revision && this.composer.text === raw) this.composer.clearText();
		if (visible) this.composer.attachments.removeSubmitted(files.map((item) => item.id));
		await this.drafts.submitted(id, raw, files, visible);
		if (visible) this.scrollToBottom.value?.();
	}

	async send(given?: string) {
		const raw = given ?? this.composer.text;
		const text = raw.trim();
		const files = this.composer.pending();
		if ((!text && !files.length) || this.store.sending.value || !this.session.workspace) return;
		if (!this.#siteAccessGranted) {
			void ext.permissions.request({ origins: ["<all_urls>"] }).then((granted) => {
				this.#siteAccessGranted = granted;
			}).catch(() => {});
		}
		if (this.session.configuring) await this.session.configuring;
		if (this.store.sending.value || !this.session.workspace) return;
		const delivery = this.session.busyMode;
		if (!this.session.connected.length) {
			if (given) this.composer.text = given;
			this.openSettings();
			return;
		}
		this.store.sending.value = true;
		const origin: Origin = { id: this.session.id, revision: this.composer.revision, load: this.drafts.generation };
		try {
			const configuration = await this.session.ensureConfiguration();
			if (files.some((item) => item.mimeType.startsWith("image/")) && !supportsVision(this.session.providers, configuration?.model)) return;
			const id = origin.id ?? await this.createChat(this.session.workspace, raw, files, origin);
			await this.session.with(id, async (target) => {
				const configured = configuration && target === this.session.chat && this.session.id === id && this.session.matches(configuration);
				if (configuration && !configured) await target.configure(configuration, context);
				const tab = this.tabs.current;
				await target.send({
					text, requestId: crypto.randomUUID(), whenBusy: delivery, attachments: files,
					...(tab?.available ? { tabId: tab.id } : {}),
				}, context);
			});
			await this.settle(id, origin, given, raw, files);
		} catch (error) {
			toastError(error);
		} finally {
			this.store.sending.value = false;
			this.composer.resize();
		}
	}

	/** Edits or resends the input at `entry` by branching the current chat; the original chat is left untouched. */
	async fork(entry: EntryId, text?: string): Promise<number | undefined> {
		const workspace = this.session.workspace;
		const parent = this.session.id;
		if (!workspace || parent === undefined || this.store.forking.value) return undefined;
		this.store.forking.value = true;
		try {
			const title = this.store.chats.value.find((chat) => chat.id === parent)?.title || t("chat.untitled");
			const id = await workspace.forkChat({ id: parent, entry, title: t("chat.branchTitle", title), requestId: crypto.randomUUID(), ...(text === undefined ? {} : { text }) }, context);
			this.selectChat(id);
			toast(t("chat.branched"));
			return id;
		} catch (error) {
			toastError(error);
			return undefined;
		} finally {
			this.store.forking.value = false;
		}
	}

	openChats(anchor = this.chatsButton.value) {
		if (!anchor) return;
		this.overlays.open({ id: "chats", kind: "drawer", anchor, component: ChatDrawer, props: { controller: this } });
	}

	selectChat(id: number | undefined) {
		this.overlays.close();
		void this.open(id);
		if (id === undefined) this.composer.focus();
	}

	openFiles(anchor = this.filesButton.value) {
		if (!anchor || !this.session.chat) return;
		this.overlays.open({ id: "files", kind: "sheet", anchor, component: FilesSheet, props: { controller: this } });
	}

	openSettings(anchor = this.settingsButton.value) {
		if (!anchor) return;
		this.overlays.open({ id: "settings", kind: "sheet", anchor, component: SettingsSheet, props: { controller: this } });
	}

	openProviderEditor(provider?: string) {
		const anchor = this.settingsButton.value;
		if (!anchor) return;
		this.overlays.open({ id: "provider", kind: "sheet", anchor, component: ProviderEditorSheet, props: { controller: this, provider } });
	}

	openModelMenu() {
		if (this.session.configuring) return;
		const anchor = this.composer.modelButton.value;
		if (this.overlays.current.value?.id === "model") return this.overlays.close();
		if (!anchor || !this.session.workspace || !this.session.connected.length) return this.openSettings();
		this.overlays.open({ id: "model", kind: "popover", anchor, component: ModelMenu, props: { controller: this } });
	}

	openThinkingMenu() {
		if (this.session.configuring) return;
		const anchor = this.composer.thinkingButton.value;
		if (this.overlays.current.value?.id === "thinking") return this.overlays.close();
		const model = this.session.model;
		if (!anchor || !this.session.workspace || !model) return;
		const levels = supportedThinkingLevels(this.session.providers, model);
		if (levels.length < 2) return;
		this.overlays.open({
			id: "thinking", kind: "popover", anchor, align: "end", component: ThinkingMenu,
			props: { controller: this, levels },
		});
	}

	openSendModeMenu() {
		const anchor = this.composer.sendModeButton.value;
		if (this.overlays.current.value?.id === "send-mode") return this.overlays.close();
		if (!anchor) return;
		this.overlays.open({
			id: "send-mode", kind: "popover", anchor, align: "end", boundary: this.composer.dock.value,
			component: SendModeMenu, props: { controller: this },
		});
	}

	requestStop(anchor: HTMLElement) {
		const target = this.session.chat;
		if (!target) return;
		const count = this.store.queue.value.length;
		if (!count) return void target.abort(context).catch(toastError);
		this.#stop = { chat: target, count };
		this.overlays.open({
			id: "stop", kind: "popover", anchor, align: "end", boundary: this.composer.dock.value,
			component: StopConfirmMenu,
			props: {
				controller: this, count,
				confirm: () => {
					this.overlays.close();
					void target.abort(context).catch(toastError);
				},
			},
		});
	}

	#syncStop() {
		if (this.overlays.current.value?.id !== "stop" || !this.#stop) return;
		if (!this.store.busy.value || this.#stop.chat !== this.session.chat || this.#stop.count !== this.store.queue.value.length) {
			const focused = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest(".stop-confirm-menu"));
			this.overlays.close(false);
			if (focused) this.composer.focus({ preventScroll: true });
		}
	}
}
