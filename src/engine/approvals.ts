import type { ApprovalDecision, ApprovalView } from "../contracts/chat.ts";
import { Published } from "./published.ts";

export type ApprovalSnapshot = { items: (ApprovalView & { chat: number })[] };
export type ApprovalRequest = Omit<ApprovalView, "id"> & { chat: number };

type Pending = { view: ApprovalView & { chat: number }; settle(allowed: boolean): void };

/** What the model reads when the user says no: an instruction, not a failure to work around. */
export const DECLINED = "The user declined this action. Do not retry it or reach the same result another way; ask what they want instead.";

/**
 * Actions waiting for the user's yes or no. They live in the Engine's memory: an Engine that is recycled while one
 * waits interrupts that tool call, which is `unsafe` and therefore never replayed.
 */
export class Approvals {
	readonly #pending = new Map<string, Pending>();
	/** Chats whose user answered "don't ask again in this chat". */
	readonly #trusted = new Set<number>();
	readonly #published = new Published<ApprovalSnapshot>({ items: [] });

	readonly observe = this.#published.observe.bind(this.#published);

	/** Resolves when the user allows the action; rejects with `DECLINED`, or with the signal's reason. */
	request(request: ApprovalRequest, signal?: AbortSignal): Promise<void> {
		if (this.#trusted.has(request.chat)) return Promise.resolve();
		signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const id = crypto.randomUUID();
			const aborted = () => {
				this.#pending.delete(id);
				this.#publish();
				reject(signal?.reason ?? new Error("aborted"));
			};
			signal?.addEventListener("abort", aborted, { once: true });
			this.#pending.set(id, {
				view: { ...request, id },
				settle: (allowed) => {
					signal?.removeEventListener("abort", aborted);
					if (allowed) resolve();
					else reject(new Error(DECLINED));
				},
			});
			this.#publish();
		});
	}

	/** `false` when the request is no longer waiting (answered in another panel, or its run was stopped). */
	decide(id: string, decision: ApprovalDecision): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;
		if (decision === "allow_chat") this.#trusted.add(pending.view.chat);
		// Trusting the chat answers everything it is waiting for, not only the request the button was on.
		const answered = decision === "allow_chat"
			? [...this.#pending.values()].filter((each) => each.view.chat === pending.view.chat) : [pending];
		for (const each of answered) {
			this.#pending.delete(each.view.id);
			each.settle(decision !== "deny");
		}
		this.#publish();
		return true;
	}

	/** A reset or removed chat: its waiting actions are declined and it is asked again from now on. */
	forget(chat: number) {
		this.#trusted.delete(chat);
		for (const [id, pending] of this.#pending) {
			if (pending.view.chat !== chat) continue;
			this.#pending.delete(id);
			pending.settle(false);
		}
		this.#publish();
	}

	close() {
		for (const pending of this.#pending.values()) pending.settle(false);
		this.#pending.clear();
		this.#published.close();
	}

	#publish() {
		this.#published.set({ items: [...this.#pending.values()].map((pending) => ({ ...pending.view })) });
	}
}
