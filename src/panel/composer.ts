import type { BusyMode, ModelRef, ProviderSummary, ThinkingLevel } from "../contracts/chat.ts";
import type { AttachmentInput } from "../lib/attachments.ts";
import { AttachmentPicker, pendingInput } from "./attachments.ts";
import type { ComposerDraft } from "./drafts.ts";
import type { DraftSource } from "./draft-session.ts";
import { ext } from "../platform/webext.ts";
import { t } from "./i18n/index.ts";
import { modelName, supportedThinkingLevels, supportsVision } from "./models.ts";
import type { TabTracker, TargetTab } from "./tab.ts";
import { h, icon, toast } from "./ui.ts";

/** Everything the composer reads from, and asks of, the rest of the panel. */
export interface ComposerHost {
	tabs: TabTracker;
	/** The tab the open chat's page tools act on, when it has one. */
	target(): number | null;
	busy(): boolean;
	/** At least one provider is configured. */
	ready(): boolean;
	providers(): readonly ProviderSummary[];
	/** The model and thinking level the chat would run with. */
	model(): ModelRef | undefined;
	thinking(): ThinkingLevel;
	whenBusy(): BusyMode;
	configuring(): boolean;
	sending(): boolean;
	onSend(): void;
	onStop(anchor: HTMLElement): void;
	onOpenModelMenu(): void;
	onOpenThinkingMenu(): void;
	onOpenSendModeMenu(): void;
	/** The content changed by typing or by attachments; drafts should be saved. */
	onChange(): void;
	/** After every render, for overlays that depend on the composer's state. */
	onRender(): void;
}

export class Composer implements DraftSource {
	readonly element: HTMLElement;
	readonly model = h("button", { class: "model-btn", id: "model", type: "button", "aria-haspopup": "listbox" });
	readonly thinking = h("button", { class: "model-btn thinking-btn", id: "thinking", type: "button", "aria-haspopup": "listbox" });
	readonly stop = h("button", { class: "send-btn stop-btn", id: "stop", type: "button", title: t("composer.stop"), "aria-label": t("composer.stop"), hidden: true }, icon("stop", 16));
	readonly sendMode = h("button", { class: "send-mode-btn", id: "send-mode", type: "button", "aria-haspopup": "menu", hidden: true });
	readonly send = h("button", { class: "send-btn", id: "send", type: "button" });
	readonly attachments = new AttachmentPicker(() => {
		this.#revision++;
		this.render();
		this.#host.onChange();
	});
	readonly #host: ComposerHost;
	readonly #context = h("div", { class: "context-row", id: "context" });
	#working: { id: number; title?: string } | undefined;
	readonly #vision = h("div", { class: "composer-notice", id: "vision-warning", role: "alert", hidden: true });
	readonly #prompt = h("textarea", { id: "prompt", rows: 1, placeholder: t("composer.placeholder"), "aria-label": t("composer.placeholder") });
	#revision = 0;

	constructor(host: ComposerHost) {
		this.#host = host;
		this.element = h("div", { class: "composer", id: "composer", "data-drop-label": t("attachments.drop") },
			this.#context, this.#vision, this.attachments.tray, this.#prompt, this.attachments.input,
			h("div", { class: "composer-bar" }, this.model, this.thinking, this.attachments.button, this.stop, this.sendMode, this.send));
		host.tabs.onChange((tab) => {
			this.#syncTarget();
			this.#renderContext(tab);
		});
		this.#listen();
	}

	get text() {
		return this.#prompt.value;
	}

	set text(value: string) {
		this.#prompt.value = value;
	}

	get revision() {
		return this.#revision;
	}

	get hasContent() {
		return Boolean(this.text.trim() || this.attachments.items.length);
	}

	/** The attachments as they would be submitted. */
	pending(): AttachmentInput[] {
		return this.attachments.items.map(pendingInput);
	}

	draft(): ComposerDraft {
		return { text: this.text, attachments: this.pending(), updatedAt: Date.now() };
	}

	restore(draft: ComposerDraft | undefined) {
		this.text = draft?.text ?? "";
		this.attachments.restore(draft?.attachments ?? []);
		this.resize();
		this.render();
	}

	reset() {
		this.#revision++;
		this.text = "";
		this.attachments.clear();
	}

	/** Clears what was just sent; later input must not be mistaken for it. */
	clearText() {
		this.text = "";
		this.#revision++;
	}

	focus(options?: FocusOptions) {
		this.#prompt.focus(options);
	}

	resize() {
		this.#prompt.style.height = "auto";
		this.#prompt.style.height = `${Math.min(this.#prompt.scrollHeight, Math.round(innerHeight * 0.4))}px`;
	}

	render() {
		const host = this.#host;
		const busy = host.busy();
		const hasContent = this.hasContent;
		const stop = busy && !hasContent;
		const ref = host.model();
		const providers = host.providers();
		const ready = host.ready();
		const whenBusy = host.whenBusy();
		document.body.dataset.busy = String(busy);
		if (this.#syncTarget()) this.#renderContext(host.tabs.current);
		this.#prompt.placeholder = busy ? t("composer.placeholderBusy") : t("composer.placeholder");
		this.stop.hidden = !busy || !hasContent;
		this.sendMode.hidden = !busy || !hasContent;
		const deliveryLabel = t(whenBusy === "steer" ? "queue.steer" : "queue.followUp");
		if (this.sendMode.dataset.mode !== whenBusy) {
			this.sendMode.dataset.mode = whenBusy;
			this.sendMode.replaceChildren(h("span", null, deliveryLabel), icon("chevron", 11));
		}
		this.sendMode.title = t("composer.delivery");
		this.sendMode.setAttribute("aria-label", `${t("composer.delivery")}: ${deliveryLabel}`);
		const mode = stop ? "stop" : "send";
		if (this.send.dataset.mode !== mode) {
			this.send.dataset.mode = mode;
			this.send.replaceChildren(icon(stop ? "stop" : "send", 16));
		}
		this.send.disabled = host.sending() || (!stop && !hasContent);
		this.send.title = stop ? t("composer.stop") : busy ? t("composer.sendBusy", deliveryLabel) : `${t("composer.send")} (Enter)`;
		this.send.setAttribute("aria-label", stop ? t("composer.stop") : busy ? deliveryLabel : t("composer.send"));
		const visionBlocked = this.attachments.hasImages && !supportsVision(providers, ref);
		this.#vision.hidden = !visionBlocked;
		if (visionBlocked) {
			this.#vision.replaceChildren(icon("alert", 15), h("span", null, t("composer.vision", ref ? modelName(providers, ref) : t("model.choose"))),
				h("button", { class: "btn small", type: "button", onclick: () => host.onOpenModelMenu() }, t("failure.chooseModel")));
		}
		const label = !ready ? t("model.connect") : ref ? modelName(providers, ref) : t("model.choose");
		if (this.model.dataset.attention !== String(!ready) || this.model.querySelector(".model-name")?.textContent !== label) {
			this.model.dataset.attention = String(!ready);
			this.model.replaceChildren(icon(ready ? "spark" : "key", 14), h("span", { class: "model-name" }, label), icon("chevron", 12));
		}
		const thinking = host.thinking();
		const thinkingLevels = supportedThinkingLevels(providers, ref);
		this.thinking.hidden = !ready || !ref || thinkingLevels.length < 2;
		this.thinking.disabled = host.configuring();
		this.model.disabled = host.configuring();
		const thinkingLabel = t(`thinking.level.${thinking}`);
		this.thinking.dataset.level = thinking;
		if (this.thinking.querySelector(".model-name")?.textContent !== thinkingLabel) {
			this.thinking.replaceChildren(icon("bulb", 14), h("span", { class: "model-name" }, thinkingLabel), ...(thinkingLevels.length > 1 ? [icon("chevron", 12)] : []));
		}
		this.thinking.title = `${t("thinking.menuTitle")}: ${thinkingLabel}`;
		this.thinking.setAttribute("aria-label", this.thinking.title);
		host.onRender();
	}

	/**
	 * While a task runs, its tab is the one it was started on (or opened since), not the tab the user has moved to.
	 * Returns whether the tab to show changed.
	 */
	#syncTarget(): boolean {
		const target = this.#host.busy() ? this.#host.target() : null;
		const id = target !== null && target !== this.#host.tabs.current?.id ? target : null;
		if (id === this.#working?.id || (id === null && !this.#working)) return false;
		this.#working = id === null ? undefined : { id };
		if (id !== null) {
			void ext.tabs.get(id).then((tab) => tab.title || tab.url || "", () => "").then((title) => {
				if (this.#working?.id !== id) return;
				this.#working = { id, title };
				this.#renderContext(this.#host.tabs.current);
			});
		}
		return true;
	}

	#workingChip() {
		const working = this.#working;
		if (!working?.title) return null;
		return h("button", {
			class: "tab-chip working", id: "working-tab", type: "button", title: t("tab.workingHint"),
			onclick: () => void ext.tabs.update(working.id, { active: true }).catch(() => undefined),
		}, h("span", { class: "spinner" }), h("span", { class: "name" }, t("tab.working", working.title)));
	}

	#renderContext(tab: TargetTab | undefined) {
		const working = this.#workingChip();
		if (!tab) {
			this.#context.replaceChildren(h("span", { class: "tab-chip", "data-access": "unavailable" }, icon("globe", 13), h("span", { class: "name" }, t("tab.none"))), ...(working ? [working] : []));
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
			? h("button", { class: "grant-btn", id: "grant", type: "button", onclick: () => this.#grant() }, icon("lock", 12), t("tab.grant")) : null;
		this.#context.replaceChildren(chip, ...(extra ? [extra] : []), ...(working ? [working] : []));
	}

	#grant() {
		// No await before the permission request: Firefox requires the click's user gesture.
		void this.#host.tabs.grant().then((granted) => toast(granted ? t("tab.granted") : t("tab.denied"), granted ? "info" : "error"));
	}

	#listen() {
		const host = this.#host;
		const element = this.element;
		this.#prompt.addEventListener("input", () => { this.#revision++; this.resize(); this.render(); host.onChange(); });
		this.#prompt.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
			event.preventDefault();
			host.onSend();
		});
		this.#prompt.addEventListener("paste", (event) => {
			const files = [...event.clipboardData?.files ?? []];
			if (!files.length) return;
			event.preventDefault();
			void this.attachments.addFiles(files);
		});
		element.addEventListener("dragover", (event) => {
			if (!event.dataTransfer?.types.includes("Files")) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			element.dataset.dragging = "true";
		});
		element.addEventListener("dragleave", (event) => {
			if (!(event.relatedTarget instanceof Node) || !element.contains(event.relatedTarget)) delete element.dataset.dragging;
		});
		element.addEventListener("drop", (event) => {
			if (!event.dataTransfer?.files.length) return;
			event.preventDefault();
			delete element.dataset.dragging;
			void this.attachments.addFiles([...event.dataTransfer.files]);
		});
		this.stop.addEventListener("click", () => host.onStop(this.stop));
		this.send.addEventListener("click", () => {
			if (this.send.dataset.mode === "stop") host.onStop(this.send);
			else host.onSend();
		});
		this.sendMode.addEventListener("click", () => host.onOpenSendModeMenu());
		this.model.addEventListener("click", () => host.onOpenModelMenu());
		this.thinking.addEventListener("click", () => host.onOpenThinkingMenu());
	}
}
