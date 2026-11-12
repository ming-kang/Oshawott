import type { AgentState, ConversationView } from "@earendil-works/pi-durable";
import {
	Chat, type BusyMode, type ChatConfiguration, DEFAULT_BUSY_MODE, type ModelRef, type ProviderSummary, type ThinkingLevel, type Workspace,
} from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import type { PanelHost } from "./connection.ts";
import { clampThinking, configuredProviders, sameModel, shownModel, supportedThinkingLevels } from "./models.ts";
import { toastError } from "./ui.ts";

export type WorkspaceRef = Extract<Reference<typeof Workspace>, { variant: "owner" }>;
export type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;

type ChatSessionStatus = "new" | "loading" | "open";

/** The Engine objects the panel is showing (`id` undefined is the new-chat screen) and the model they would run with. */
export class ChatSession {
	readonly #host: PanelHost;
	readonly #changed: () => void;
	#workspace: WorkspaceRef | undefined;
	#chat: ChatRef | undefined;
	#id: number | undefined;
	#loaded = false;
	#generation = 0;
	#task: Promise<void> | undefined;

	/** `changed` runs for observed chat updates and when `configuring` flips. */
	constructor(host: PanelHost, changed: () => void) {
		this.#host = host;
		this.#changed = changed;
	}

	get workspace() {
		return this.#workspace;
	}

	get chat() {
		return this.#chat;
	}

	get id() {
		return this.#id;
	}

	get loaded() {
		return this.#loaded;
	}

	get status(): ChatSessionStatus {
		return this.#id === undefined ? "new" : this.#chat ? "open" : "loading";
	}

	get busyMode(): BusyMode {
		return this.#workspace?.busyMode.value ?? DEFAULT_BUSY_MODE;
	}

	attachWorkspace(workspace: WorkspaceRef) {
		this.#workspace = workspace;
	}

	markLoaded() {
		this.#loaded = true;
	}

	/**
	 * Opens one chat and owns its reference and watchers. `prepare` coordinates the draft/UI transition and calls
	 * `commit` synchronously, so the old view is released before the new draft or remote reference is awaited.
	 */
	async open(id: number | undefined, prepare: (commit: () => void) => Promise<void>) {
		const generation = ++this.#generation;
		await prepare(() => {
			this.#chat?.release();
			this.#chat = undefined;
			this.#id = id;
		});
		if (id === undefined) return;
		const next = await this.#host.get(Chat, { id }, BACKGROUND_CONTEXT);
		if (generation !== this.#generation || this.#id !== id || next.variant !== "owner") {
			next.release();
			return;
		}
		let watches;
		try {
			watches = await Promise.all([next.view, next.approvals, next.target].map((member) => member.watch(BACKGROUND_CONTEXT)));
		} catch (error) {
			next.release();
			throw error;
		}
		if (generation !== this.#generation || this.#id !== id) {
			next.release();
			return;
		}
		this.#chat = next;
		for (const watch of watches) watch.start(async () => {
			if (this.#chat === next) this.#changed();
		});
		this.#changed();
	}

	async setBusyMode(mode: BusyMode) {
		const workspace = this.#workspace;
		if (!workspace) throw new Error("The workspace is not ready.");
		await workspace.setBusyMode(mode, BACKGROUND_CONTEXT);
	}

	/** The visible chat; throws while none is open. */
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

	/** The configuration change in flight, if any. */
	get configuring() {
		return this.#task;
	}

	get model(): ModelRef | undefined {
		return shownModel(this.providers, this.#current);
	}

	get thinking(): ThinkingLevel {
		return this.thinkingFor(this.model);
	}

	/** The current thinking level, clamped to what `model` supports. */
	thinkingFor(model: ModelRef | undefined): ThinkingLevel {
		return clampThinking(supportedThinkingLevels(this.providers, model), this.#thinking);
	}

	/** The model and thinking level a new message would run with. */
	get configuration(): ChatConfiguration | undefined {
		const model = this.model;
		return model ? { model, thinkingLevel: this.thinking } : undefined;
	}

	/** Runs `use` on chat `id`: the visible chat if it is, otherwise one held just for the call. */
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

	/** Whether the visible chat already runs with `configuration`. */
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
		if (this.#task) return this.#task;
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
		this.#task = task;
		this.#changed();
		return task.finally(() => {
			if (this.#task === task) this.#task = undefined;
			this.#changed();
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
