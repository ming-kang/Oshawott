import type { LoginView, ProviderSummary, Workspace } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { t } from "./i18n.ts";
import { requestOrigins } from "./model-permissions.ts";
import { copyText, h, icon, toast } from "./ui.ts";

export type LoginSource = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"logins" | "startLogin" | "answerLogin" | "cancelLogin" | "dismissLogin" | "logout"
>;
const context = BACKGROUND_CONTEXT;
const fail = (error: unknown) => toast(String((error as Error)?.message ?? error), "error");

/** Account sign-in for one built-in provider. The Engine owns the session; this card only shows it and answers it. */
export class LoginCard {
	readonly element = h("div", { class: "login-card", id: "provider-login", hidden: true });
	readonly #source: () => LoginSource | undefined;
	readonly #provider: () => ProviderSummary | undefined;
	readonly #onSignedIn: () => void;
	readonly #seen = new Set<string>();
	#shown = "";
	#busy = false;

	constructor(source: () => LoginSource | undefined, provider: () => ProviderSummary | undefined, onSignedIn: () => void) {
		this.#source = source;
		this.#provider = provider;
		this.#onSignedIn = onSignedIn;
	}

	/** The sign-in the Engine holds for the shown provider, pending or just finished. */
	get session(): LoginView | undefined {
		const provider = this.#provider();
		return provider && this.#source()?.logins.value.find((login) => login.provider === provider.id);
	}

	refresh() {
		const provider = this.#provider();
		const session = this.session;
		if (session && session.status !== "pending" && session.status !== "failed" && !this.#seen.has(session.id)) {
			this.#seen.add(session.id);
			// The outcome is read once; the provider summary carries the result from here on.
			void this.#source()?.dismissLogin({ id: session.id }, context).catch(() => undefined);
			if (session.status === "done") {
				toast(t("login.signedIn"));
				this.#onSignedIn();
			}
		}
		this.element.hidden = !provider?.oauth;
		// Rebuilt only when what is shown changes, so a refresh never clears a code being typed.
		const shown = JSON.stringify([provider?.id, provider?.auth, provider?.oauth?.label, session, this.#busy]);
		if (shown === this.#shown) return;
		this.#shown = shown;
		this.element.replaceChildren(...(provider?.oauth ? this.#content(provider, session) : []));
	}

	#content(provider: ProviderSummary, session: LoginView | undefined): HTMLElement[] {
		const title = h("span", { class: "login-title" }, t("login.title"));
		if (session?.status === "pending") return [title, ...this.#pending(session)];
		const start = h("button", {
			class: "btn", id: "login-start", type: "button", disabled: this.#busy, onclick: () => void this.#start(provider),
		}, icon("key", 14), provider.oauth!.label);
		if (session?.status === "failed") {
			const reason = session.error === "http" ? t("login.error.http", session.httpStatus ?? "") : t(`login.error.${session.error ?? "unknown"}`);
			return [title, h("p", { class: "login-error", id: "login-error", role: "alert" }, reason), start];
		}
		if (provider.auth !== "oauth") return [title, start];
		return [
			h("div", { class: "login-row" }, title, h("span", { class: "pill", "data-on": true }, t("login.signedIn"))),
			h("button", { class: "btn", id: "login-out", type: "button", disabled: this.#busy, onclick: () => void this.#signOut(provider) }, t("login.signOut")),
		];
	}

	#pending(session: LoginView): HTMLElement[] {
		const parts: HTMLElement[] = [];
		const status = session.progress ?? (session.userCode ? t("login.codeHint") : session.url ? t("login.openHint") : t("login.starting"));
		parts.push(h("p", { class: "login-status", id: "login-status", role: "status" }, h("span", { class: "spinner" }), status));
		if (session.userCode) {
			const code = session.userCode;
			parts.push(h("div", { class: "login-row" },
				h("code", { class: "login-code", id: "login-code" }, code),
				h("button", {
					class: "btn small", id: "login-copy", type: "button",
					onclick: async () => toast(await copyText(code) ? t("copied") : t("login.copyFailed"), "info"),
				}, icon("copy", 14), t("copy"))));
		}
		// An ordinary link: the page opens only when the user clicks it.
		if (session.url) {
			parts.push(h("a", { class: "btn", id: "login-open", href: session.url, target: "_blank", rel: "noopener noreferrer" },
				icon("external", 14), t("login.open")));
		}
		if (session.prompt) parts.push(this.#prompt(session, session.prompt));
		parts.push(h("button", {
			class: "btn ghost", id: "login-cancel", type: "button",
			onclick: () => void this.#source()?.cancelLogin({ id: session.id }, context).catch(fail),
		}, t("login.cancel")));
		return parts;
	}

	#prompt(session: LoginView, prompt: NonNullable<LoginView["prompt"]>): HTMLElement {
		const field = prompt.kind === "select"
			? h("select", { class: "input", id: "login-answer" }, ...prompt.options.map((option) => h("option", { value: option.id }, option.label)))
			: h("input", {
				class: "input", id: "login-answer", type: prompt.kind === "secret" ? "password" : "text",
				placeholder: prompt.placeholder, autocomplete: "off", spellcheck: "false",
			});
		const submit = h("button", { class: "btn primary", id: "login-continue", type: "submit" }, t("login.continue"));
		return h("form", {
			class: "login-prompt",
			onsubmit: (event: Event) => {
				event.preventDefault();
				submit.disabled = true;
				const value = field.value;
				field.value = "";
				void this.#source()?.answerLogin({ id: session.id, promptId: prompt.id, value }, context).catch(fail);
			},
		}, h("label", { class: "provider-field" }, h("span", null, prompt.kind === "code" ? t("login.pasteCode") : prompt.message), field), submit);
	}

	async #start(provider: ProviderSummary) {
		// Asked before anything is awaited: Firefox requires the click's user gesture.
		const asked = requestOrigins(provider.oauth?.origins ?? []);
		await this.#run(async (source) => {
			if (!await asked) throw new Error(t("settings.permissionDenied"));
			await source.startLogin({ provider: provider.id }, context);
		});
	}

	async #signOut(provider: ProviderSummary) {
		await this.#run(async (source) => {
			await source.logout({ provider: provider.id }, context);
			toast(t("login.signedOut"));
		});
	}

	async #run(work: (source: LoginSource) => Promise<void>) {
		if (this.#busy) return;
		this.#busy = true;
		this.refresh();
		try {
			const source = this.#source();
			if (!source) throw new Error(t("reconnecting"));
			await work(source);
		} catch (error) {
			fail(error);
		} finally {
			this.#busy = false;
			this.refresh();
		}
	}
}
