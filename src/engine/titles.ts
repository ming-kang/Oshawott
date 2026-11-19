import type { MutableModels } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type Harness, ProviderDoc, type SubmissionId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { preference, WorkspaceDoc, type WorkspaceState } from "./docs.ts";
import type { ProviderManager } from "./providers.ts";

export const TITLE_TIMEOUT_MS = 15_000;
const TITLE_MAX_TOKENS = 64;
const TITLE_REQUEST =
	"Reply with only a short, specific title for this conversation, in the user's language: at most 48 characters, " +
	"no quotes, no Markdown, no trailing period. Do not call tools.";

export function titleOf(text: string): string {
	const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
	const chars = [...line];
	return chars.length > 48 ? `${chars.slice(0, 47).join("")}…` : line;
}

function generatedTitle(text: string): string {
	const cleaned = text.trim().replace(/^(?:title|标题)\s*[:：]\s*/i, "").replace(/^["'“‘]+|["'”’]+$/g, "");
	return titleOf(cleaned);
}

interface TitleOptions {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly providers: ProviderManager;
	readonly timeoutMs?: number;
}

/** Process-local by design: an Engine interruption leaves the fallback title and never resumes a title request. */
export class ChatTitles {
	readonly #options: TitleOptions;
	readonly #tasks = new Map<number, Promise<void>>();
	readonly #controllers = new Map<number, AbortController>();
	#closed = false;

	constructor(options: TitleOptions) {
		this.#options = options;
	}

	schedule(chatId: number, submissionId: number, fallback: string) {
		if (this.#closed || this.#tasks.has(chatId)) return;
		const task = this.#run(chatId, submissionId as SubmissionId, fallback).catch(() => {
			// Titles are best-effort: provider errors, timeout, deletion and Engine close never fail the conversation.
		}).finally(() => {
			this.#tasks.delete(chatId);
			this.#controllers.delete(chatId);
		});
		this.#tasks.set(chatId, task);
	}

	close() {
		this.#closed = true;
		for (const controller of this.#controllers.values()) controller.abort();
	}

	/**
	 * Scheduled only by the commit that marks a chat's first input, which is never repeated, and never resumed after an
	 * Engine restart, so at most one request is made per chat. Any manual rename changes `titleSource` for good, which
	 * invalidates an in-flight result.
	 */
	async #run(chatId: number, submissionId: SubmissionId, fallback: string) {
		const { harness } = this.#options;
		const conversationId = chatId as ConversationId;
		const submission = await harness.submission(submissionId, BACKGROUND_CONTEXT);
		if (!submission) return;
		const settled = await submission.wait(BACKGROUND_CONTEXT);
		if (settled.status !== "done" || settled.type !== "input") return;

		const [target, agent, workspace, provider] = await Promise.all([
			harness.conversation(conversationId, BACKGROUND_CONTEXT),
			harness.snapshot(AgentDoc, conversationId, BACKGROUND_CONTEXT),
			harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT),
			harness.snapshot(ProviderDoc, conversationId, BACKGROUND_CONTEXT),
		]);
		if (!target || this.#closed || !replaceable(workspace, chatId, fallback)) return;
		const view = await target.context(BACKGROUND_CONTEXT);
		// No title for a failed or interrupted first answer.
		const answer = view.entries.find((entry) => entry.id === settled.answer);
		if (answer?.model?.find((message) => message.role === "assistant")?.stopReason !== "stop") return;
		const ref = agent?.model ?? workspace?.defaultModel;
		const model = ref ? this.#options.providers.model(ref) : undefined;
		if (!model || this.#closed) return;

		const controller = new AbortController();
		this.#controllers.set(chatId, controller);
		const timeoutMs = this.#options.timeoutMs ?? TITLE_TIMEOUT_MS;
		// The request is the conversation's own model context plus the title question, so it shares the cached
		// prefix — system messages carry the prompt and tools — and the provider session. Thinking stays what the
		// agent uses: a different level would invalidate some providers' message cache.
		const thinking = agent?.thinkingLevel ?? "off";
		const result = await this.#options.models.completeSimple(model, {
			messages: [...view.messages, { role: "user", timestamp: Date.now(), content: TITLE_REQUEST }],
		}, {
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
			timeoutMs,
			maxRetries: 0,
			...(provider?.sessionId === undefined ? {} : { sessionId: provider.sessionId }),
			...(thinking === "off" ? { maxTokens: TITLE_MAX_TOKENS } : { reasoning: thinking }),
		});
		if (this.#closed || result.stopReason !== "stop" || result.content.some((block) => block.type === "toolCall")) return;
		const title = generatedTitle(result.content.filter((block) => block.type === "text").map((block) => block.text).join(" "));
		if (!title) return;
		await harness.commit(async (tx) => {
			const doc = await tx.doc(WorkspaceDoc);
			if (!replaceable(doc, chatId, fallback)) return;
			const summary = doc.chats.find((chat) => chat.id === chatId)!;
			summary.title = title;
			summary.titleSource = "auto";
		}, BACKGROUND_CONTEXT);
	}
}

/** Only a still-enabled preference and an untouched fallback title may be replaced. */
function replaceable(workspace: WorkspaceState | undefined, chatId: number, fallback: string) {
	const summary = workspace?.chats.find((chat) => chat.id === chatId);
	return preference(workspace, "autoTitle") && summary?.titleSource === "fallback" && summary.title === fallback;
}
