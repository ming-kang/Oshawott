import type { MutableModels, UserMessage } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type Harness, type SubmissionId } from "@earendil-works/pi-durable";
import { userInput } from "../lib/attachments.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { WorkspaceDoc, type WorkspaceState } from "./docs.ts";
import type { ProviderManager } from "./providers.ts";

export const TITLE_TIMEOUT_MS = 15_000;
const TITLE_INPUT_CHARS = 8_000;
const TITLE_MAX_TOKENS = 64;

export function titleOf(text: string): string {
	const line = text.trim().split("\n")[0]!.replace(/\s+/g, " ");
	const chars = [...line];
	return chars.length > 48 ? `${chars.slice(0, 47).join("")}…` : line;
}

function generatedTitle(text: string): string {
	const cleaned = text.trim().replace(/^(?:title|标题)\s*[:：]\s*/i, "").replace(/^["'“‘]+|["'”’]+$/g, "");
	return titleOf(cleaned);
}

function messageText(message: UserMessage): string {
	return typeof message.content === "string" ? message.content
		: message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
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

		const [target, agent, workspace] = await Promise.all([
			harness.conversation(conversationId, BACKGROUND_CONTEXT),
			harness.snapshot(AgentDoc, conversationId, BACKGROUND_CONTEXT), harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT),
		]);
		if (!target || this.#closed || !replaceable(workspace, chatId, fallback)) return;
		const context = await target.context(BACKGROUND_CONTEXT);
		const user = context.entries.find((entry) => entry.id === settled.entry);
		const answer = context.entries.find((entry) => entry.id === settled.answer);
		const userMessage = user?.model?.find((message) => message.role === "user");
		const answerMessage = answer?.model?.find((message) => message.role === "assistant");
		if (!userMessage || answerMessage?.role !== "assistant" || answerMessage.stopReason !== "stop") return;
		const question = userInput(user, userMessage.content).text || messageText(userMessage);
		const answerText = answerMessage.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
		if (!question.trim() || !answerText) return;
		const ref = agent?.model ?? workspace?.defaultModel;
		const model = ref ? this.#options.providers.model(ref) : undefined;
		if (!model || this.#closed) return;

		const controller = new AbortController();
		this.#controllers.set(chatId, controller);
		const timeoutMs = this.#options.timeoutMs ?? TITLE_TIMEOUT_MS;
		const result = await this.#options.models.completeSimple(model, {
			systemPrompt: "Write one short, specific conversation title. Return only the title, without quotes, Markdown, or a trailing period.",
			messages: [{ role: "user", timestamp: Date.now(), content:
				`Title this conversation in the user's language, in at most 48 characters.\n\nUser:\n${question.slice(0, TITLE_INPUT_CHARS)}\n\nAssistant:\n${answerText.slice(0, TITLE_INPUT_CHARS)}` }],
		}, {
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]), timeoutMs,
			maxRetries: 0, maxTokens: TITLE_MAX_TOKENS,
		});
		if (this.#closed || result.stopReason !== "stop") return;
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
	return Boolean(workspace?.autoTitle && summary?.titleSource === "fallback" && summary.title === fallback);
}
