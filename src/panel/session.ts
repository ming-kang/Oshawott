import type { AgentState, ConversationView } from "@earendil-works/pi-durable";
import { shallowRef } from "vue";
import {
	Chat, type ApprovalView, type BusyMode, type ChatConfiguration, DEFAULT_BUSY_MODE, type ModelRef, type ProviderSummary, type ThinkingLevel, type Workspace,
} from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import type { PanelHost } from "./connection.ts";
import { clampThinking, configuredProviders, sameModel, shownModel, supportedThinkingLevels } from "./models.ts";
import { toastError } from "./ui.ts";
import { watchMember } from "./watch-member.ts";

export type WorkspaceRef = Extract<Reference<typeof Workspace>, { variant: "owner" }>;
export type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;

type ChatSessionStatus = "new" | "loading" | "open";

/** The Engine objects the panel is showing (`id` undefined is the new-chat screen) and the model they would run with. */
export class ChatSession {
	readonly #host: PanelHost;
	readonly #viewChanged: () => void;
	#workspace: WorkspaceRef | undefined;
	readonly #chat = shallowRef<ChatRef>();
	readonly #id = shallowRef<number>();
	readonly #loaded = shallowRef(false);
	readonly approvals = shallowRef<readonly ApprovalView[]>([]);
	readonly target = shallowRef<number | null>(null);
	#generation = 0;
	readonly #task = shallowRef<Promise<void>>();

	constructor(host: PanelHost, viewChanged: () => void) {
		this.#host = host;
		this.#viewChanged = viewChanged;
	}

	get workspace() {
		return this.#workspace;
	}

	get chat() {
		return this.#chat.value;
	}

	get id() {
		return this.#id.value;
	}

	get loaded() {
		return this.#loaded.value;
	}

	get status(): ChatSessionStatus {
		return this.id === undefined ? "new" : this.chat ? "open" : "loading";
	}

	get busyMode(): BusyMode {
		return this.#workspace?.busyMode.value ?? DEFAULT_BUSY_MODE;
	}

	attachWorkspace(workspace: WorkspaceRef) {
		this.#workspace = workspace;
	}

	markLoaded() {
		this.#loaded.value = true;
	}

	/**
	 * Opens one chat and owns its reference and watchers. `prepare` coordinates the draft/UI transition and calls
	 * `commit` synchronously, so the old view is released before the new draft or remote reference is awaited.
	 */
	async open(id: number | undefined, prepare: (commit: () => void) => Promise<void>) {
		const generation = ++this.#generation;
		await prepare(() => {
			this.chat?.release();
			this.#chat.value = undefined;
			this.#id.value = id;
			this.approvals.value = [];
			this.target.value = null;
		});
		if (id === undefined) return;
		const next = await this.#host.get(Chat, { id }, BACKGROUND_CONTEXT);
		if (generation !== this.#generation || this.id !== id || next.variant !== "owner") {
			next.release();
			return;
		}
		let watches;
		try {
			watches = await Promise.all([
				next.view.watch(BACKGROUND_CONTEXT), next.approvals.watch(BACKGROUND_CONTEXT), next.target.watch(BACKGROUND_CONTEXT),
			]);
		} catch (error) {
			next.release();
			throw error;
		}
		if (generation !== this.#generation || this.id !== id) {
			next.release();
			return;
		}
		this.#chat.value = next;
		const [view, approvals, target] = watches;
		watchMember(view, () => {
			if (this.chat === next) this.#viewChanged();
		});
		watchMember(approvals, (value) => {
			if (this.chat === next) this.approvals.value = value;
		});
		watchMember(target, (value) => {
			if (this.chat === next) this.target.value = value;
		});
	}

	get opened(): ChatRef {
		if (!this.chat) throw new Error("The chat is not open.");
		return this.chat;
	}

	get providers(): readonly ProviderSummary[] {
		return this.workspace?.providers.value ?? [];
	}

	get connected() {
		return configuredProviders(this.providers);
	}

	get chats() {
		return this.workspace?.chats.value ?? [];
	}

	get view(): ConversationView | null {
		return this.loaded && this.id !== undefined ? this.chat?.view.value ?? null : null;
	}

	get configuring() {
		return this.#task.value;
	}

	get model(): ModelRef | undefined {
		return shownModel(this.providers, this.#current);
	}

	get thinking(): ThinkingLevel {
		return this.thinkingFor(this.model);
	}

	thinkingFor(model: ModelRef | undefined): ThinkingLevel {
		return clampThinking(supportedThinkingLevels(this.providers, model), this.#thinking);
	}

	get configuration(): ChatConfiguration | undefined {
		const model = this.model;
		return model ? { model, thinkingLevel: this.thinking } : undefined;
	}

	async with<T>(id: number, use: (target: ChatRef) => Promise<T>): Promise<T> {
		if (this.id === id && this.chat) return use(this.chat);
		const held = await this.#host.get(Chat, { id }, BACKGROUND_CONTEXT);
		if (held.variant !== "owner") {
			held.release();
			throw new Error("The Engine refused the chat.");
		}
		try {
			return await use(held);
		} finally {
			held.release();
		}
	}

	matches(configuration: ChatConfiguration) {
		return sameModel(this.#chatModel, configuration.model) && (this.#agent?.thinkingLevel ?? "off") === configuration.thinkingLevel;
	}

	/** Before the first send creates a chat, its shown configuration becomes the Workspace default. */
	async ensureConfiguration(): Promise<ChatConfiguration | undefined> {
		const configuration = this.configuration;
		if (configuration && this.id === undefined && this.workspace
			&& (!sameModel(configuration.model, this.#current) || configuration.thinkingLevel !== this.#thinking)) {
			await this.workspace.setDefaultConfiguration(configuration, BACKGROUND_CONTEXT);
		}
		return configuration;
	}

	/** One change at a time; a second caller shares the running one. */
	configure(configuration: ChatConfiguration): Promise<void> {
		if (this.configuring) return this.configuring;
		const source = this.workspace;
		const id = this.id;
		const task = (async () => {
			try {
				// Chat.configure updates both the chat and the default in one Engine transaction. A loading chat still
				// has an id, so hold it for this call rather than silently changing only the default.
				if (id !== undefined) await this.with(id, (target) => target.configure(configuration, BACKGROUND_CONTEXT));
				else await source?.setDefaultConfiguration(configuration, BACKGROUND_CONTEXT);
			} catch (error) {
				toastError(error);
			}
		})();
		this.#task.value = task;
		return task.finally(() => {
			if (this.#task.value === task) this.#task.value = undefined;
		});
	}

	get #agent() {
		return this.view?.docs["pi.agent"] as AgentState | undefined;
	}

	get #chatModel() {
		return this.#agent?.model;
	}

	get #current(): ModelRef | undefined {
		return this.#chatModel ?? this.workspace?.defaultModel.value ?? undefined;
	}

	get #thinking(): ThinkingLevel {
		return this.id === undefined ? this.workspace?.defaultThinkingLevel.value ?? "off" : this.#agent?.thinkingLevel ?? "off";
	}
}
