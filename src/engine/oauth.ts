import type { AuthEvent, AuthPrompt, Models } from "@earendil-works/pi-ai";
import type { Observation, Observer } from "@earendil-works/pi-durable";
import type { LoginError, LoginView } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";

/** How a browser completes one provider's Pi-AI sign-in. */
export interface OAuthSetup {
	/** Match patterns of the token and API hosts the Engine must reach. */
	readonly origins: readonly string[];
	/** The answer to the flow's method choice: the one method that needs no loopback callback. */
	readonly select?: string;
	/** The answer to the flow's free-text question (GitHub Enterprise domain: none). */
	readonly text?: string;
}
export type OAuthSetups = Readonly<Record<string, OAuthSetup>>;

export type LoginSnapshot = { items: LoginView[] };

export interface LoginSessionsOptions {
	readonly models: Models;
	readonly setups?: OAuthSetups;
	readonly now?: () => number;
	/** The whole sign-in, whatever the provider's own device-code lifetime. */
	readonly timeoutMs?: number;
	/** How long a finished sign-in's outcome stays visible to a Panel that has not dismissed it. */
	readonly settledMs?: number;
}

export const LOGIN_TIMEOUT_MS = 15 * 60_000;
const SETTLED_MS = 60_000;
const MAX_TEXT = 300;

type Session = {
	view: LoginView;
	readonly controller: AbortController;
	answer?: (value: string) => void;
	ended?: "cancelled" | "timeout";
	timer?: ReturnType<typeof setTimeout>;
};

const httpsUrl = (value: string): string | null => {
	if (!URL.canParse(value)) return null;
	const url = new URL(value);
	return url.protocol === "https:" ? url.href : null;
};

/**
 * Pi-AI's login errors quote provider responses, which can carry tokens or codes. A Panel gets only this classification;
 * the original error is neither published nor logged.
 */
export function loginFailure(error: unknown): { error: LoginError; httpStatus: number | null } {
	const message = error instanceof Error ? error.message : "";
	const of = (code: LoginError) => ({ error: code, httpStatus: null });
	if (/state mismatch/i.test(message)) return of("mismatch");
	if (/missing authorization code/i.test(message)) return of("missing_code");
	if (/\bdenied\b/i.test(message)) return of("denied");
	if (/expired|timed out/i.test(message)) return of("expired");
	if (/failed to fetch|networkerror|load failed|fetch failed/i.test(message)) return of("network");
	const status = /(?:status[= ]|HTTP |\()([1-5]\d\d)\b/.exec(message)?.[1];
	return status ? { error: "http", httpStatus: Number(status) } : of("unknown");
}

/**
 * The Engine's account sign-ins: at most one pending per provider, shared by every Panel, gone with the Engine.
 * Pi-AI runs the protocol and stores the credential; this class only carries its `notify` / `prompt` interaction.
 */
export class LoginSessions {
	readonly #models: Models;
	readonly #setups: OAuthSetups;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #settledMs: number;
	readonly #sessions = new Map<string, Session>();
	readonly #observers = new Set<Observer<LoginSnapshot>>();
	#value: LoginSnapshot = { items: [] };
	#closed = false;

	constructor(options: LoginSessionsOptions) {
		this.#models = options.models;
		this.#setups = options.setups ?? {};
		this.#now = options.now ?? Date.now;
		this.#timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS;
		this.#settledMs = options.settledMs ?? SETTLED_MS;
	}

	/** A Chord-followable snapshot, as `ConversationActivity.observe`. */
	observe(observer: Observer<LoginSnapshot>): Promise<Observation<LoginSnapshot>> {
		this.#observers.add(observer);
		return Promise.resolve({ value: this.#value, detach: () => { this.#observers.delete(observer); } });
	}

	start(provider: string): string {
		if (this.#closed) throw new Error("The Engine is closing.");
		if (!this.#models.getProvider(provider)?.auth.oauth) throw new Error(`${provider} has no account sign-in.`);
		for (const [id, session] of this.#sessions) {
			if (session.view.provider !== provider) continue;
			if (session.view.status === "pending") return id;
			this.#forget(id);
		}
		const id = crypto.randomUUID();
		const session: Session = {
			view: {
				id, provider, status: "pending", url: null, userCode: null, expiresAt: null, progress: null, prompt: null,
				error: null, httpStatus: null,
			},
			controller: new AbortController(),
		};
		session.timer = setTimeout(() => this.#abort(session, "timeout"), this.#timeoutMs);
		this.#sessions.set(id, session);
		this.#publish();
		void this.#models.login(provider, "oauth", {
			signal: session.controller.signal,
			notify: (event) => this.#notify(session, event),
			prompt: (prompt) => this.#prompt(session, prompt),
		}, { agentName: "Oshawott" }).then(
			() => this.#settle(session, { status: "done" }),
			(error: unknown) => this.#settle(session, session.ended === "cancelled"
				? { status: "cancelled" }
				: { status: "failed", ...(session.ended === "timeout" ? { error: "timeout" as const, httpStatus: null } : loginFailure(error)) }),
		);
		return id;
	}

	answer(id: string, promptId: string, value: string) {
		const session = this.#sessions.get(id);
		if (!session?.answer || session.view.prompt?.id !== promptId) throw new Error("This sign-in step is no longer waiting for an answer.");
		session.answer(value);
	}

	cancel(id: string) {
		const session = this.#sessions.get(id);
		if (session) this.#abort(session, "cancelled");
	}

	cancelProvider(provider: string) {
		for (const session of this.#sessions.values()) if (session.view.provider === provider) this.#abort(session, "cancelled");
	}

	dismiss(id: string) {
		if (this.#sessions.get(id)?.view.status === "pending") return;
		this.#forget(id);
		this.#publish();
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const [id, session] of this.#sessions) {
			this.#abort(session, "cancelled");
			this.#forget(id);
		}
		for (const observer of this.#observers) observer.end({ kind: "ended" });
		this.#observers.clear();
	}

	#abort(session: Session, reason: "cancelled" | "timeout") {
		if (session.view.status !== "pending" || session.ended) return;
		session.ended = reason;
		session.controller.abort(new Error("Login cancelled"));
	}

	#forget(id: string) {
		clearTimeout(this.#sessions.get(id)?.timer);
		this.#sessions.delete(id);
	}

	#notify(session: Session, event: AuthEvent) {
		if (session.view.status !== "pending") return;
		const view = session.view;
		if (event.type === "auth_url") view.url = httpsUrl(event.url);
		else if (event.type === "device_code") {
			view.url = httpsUrl(event.verificationUri);
			view.userCode = event.userCode.slice(0, MAX_TEXT);
			view.expiresAt = event.expiresInSeconds ? this.#now() + event.expiresInSeconds * 1000 : null;
		} else view.progress = event.message.slice(0, MAX_TEXT);
		this.#publish();
	}

	#prompt(session: Session, prompt: AuthPrompt): Promise<string> {
		const setup = this.#setups[session.view.provider];
		if (prompt.type === "select" && setup?.select !== undefined && prompt.options.some((option) => option.id === setup.select)) {
			return Promise.resolve(setup.select);
		}
		if (prompt.type === "text" && setup?.text !== undefined) return Promise.resolve(setup.text);
		return new Promise((resolve, reject) => {
			const signals = [session.controller.signal, ...(prompt.signal ? [prompt.signal] : [])];
			const finish = () => {
				for (const signal of signals) signal.removeEventListener("abort", cancel);
				session.answer = undefined;
				session.view.prompt = null;
				this.#publish();
			};
			const cancel = () => {
				finish();
				reject(new Error("Login cancelled"));
			};
			if (signals.some((signal) => signal.aborted)) return reject(new Error("Login cancelled"));
			for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
			session.view.prompt = {
				id: crypto.randomUUID(),
				kind: prompt.type === "manual_code" ? "code" : prompt.type,
				message: prompt.message.slice(0, MAX_TEXT),
				placeholder: ("placeholder" in prompt ? prompt.placeholder ?? "" : "").slice(0, MAX_TEXT),
				options: prompt.type === "select" ? prompt.options.map(({ id, label }) => ({ id, label })) : [],
			};
			session.answer = (value) => {
				finish();
				resolve(value);
			};
			this.#publish();
		});
	}

	#settle(session: Session, outcome: Pick<LoginView, "status"> & Partial<Pick<LoginView, "error" | "httpStatus">>) {
		clearTimeout(session.timer);
		session.answer = undefined;
		session.view = {
			...session.view, url: null, userCode: null, expiresAt: null, progress: null, prompt: null, error: null, httpStatus: null,
			...outcome,
		};
		if (this.#closed || this.#sessions.get(session.view.id) !== session) return;
		session.timer = setTimeout(() => this.dismiss(session.view.id), this.#settledMs);
		this.#publish();
	}

	#publish() {
		if (this.#closed) return;
		const value = { items: [...this.#sessions.values()].map((session) => structuredClone(session.view)) };
		this.#value = value;
		for (const observer of this.#observers) {
			observer.advance({ kind: "value", value, ops: [["r", value]], retired: false }, BACKGROUND_CONTEXT);
		}
	}
}
