import { computed, defineComponent, shallowRef, watch, type PropType } from "vue";
import type { LoginView, ProviderSummary } from "../contracts/chat.ts";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { Icon } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { t } from "./i18n/index.ts";
import { copyText, toast, toastError } from "./ui.ts";

const context = BACKGROUND_CONTEXT;

/** The Engine owns sign-in; this component only renders its public LoginView and answers prompts. */
export const LoginCard = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		provider: { type: Object as PropType<ProviderSummary> },
		onSignedIn: { type: Function as PropType<() => void>, required: true },
	},
	setup(props) {
		const busy = shallowRef(false);
		const answering = shallowRef(false);
		const seen = new Set<string>();
		const session = computed(() => props.provider && props.controller.store.logins.value.find((login) => login.provider === props.provider!.id));
		watch(session, (current) => {
			if (!current || current.status === "pending" || current.status === "failed" || seen.has(current.id)) return;
			seen.add(current.id);
			void props.controller.workspace?.dismissLogin({ id: current.id }, context).catch(() => undefined);
			if (current.status === "done") {
				toast(t("login.signedIn"));
				props.onSignedIn();
			}
		}, { immediate: true });
		const run = async (work: () => Promise<void>) => {
			if (busy.value) return;
			busy.value = true;
			try { await work(); } catch (error) { toastError(error); } finally { busy.value = false; }
		};
		const start = (provider: ProviderSummary) => {
			void run(async () => {
				const source = props.controller.workspace;
				if (!source) throw new Error(t("reconnecting"));
				await source.startLogin({ provider: provider.id }, context);
			});
		};
		const signOut = (provider: ProviderSummary) => void run(async () => {
			const source = props.controller.workspace;
			if (!source) throw new Error(t("reconnecting"));
			await source.removeCredential({ provider: provider.id }, context);
			toast(t("login.signedOut"));
		});
		const pending = (current: LoginView) => (
			<>
				<p class="login-status" id="login-status" role="status"><span class="spinner" />{current.progress ?? (current.userCode ? t("login.codeHint") : current.url ? t("login.openHint") : t("login.starting"))}</p>
				{current.userCode && <div class="login-row"><code class="login-code" id="login-code">{current.userCode}</code>
					<button class="btn small" id="login-copy" type="button" onClick={async () => { if (await copyText(current.userCode!)) toast(t("copied")); else toast(t("login.copyFailed"), "error"); }}>
						<Icon name="copy" size={14} />{t("copy")}</button></div>}
				{current.url && <a class="btn" id="login-open" href={current.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={14} />{t("login.open")}</a>}
				{current.prompt && (
					<form class="login-prompt" onSubmit={(event) => {
						event.preventDefault();
						const form = event.currentTarget as HTMLFormElement;
						const field = form.elements.namedItem("answer") as HTMLInputElement | HTMLSelectElement;
						const value = field.value;
						field.value = "";
						answering.value = true;
						void props.controller.workspace?.answerLogin({ id: current.id, promptId: current.prompt!.id, value }, context)
							.catch(toastError).finally(() => { answering.value = false; });
					}}>
						<label class="provider-field"><span>{current.prompt.kind === "code" ? t("login.pasteCode") : current.prompt.message}</span>
							{current.prompt.kind === "select"
								? <select class="input" id="login-answer" name="answer" disabled={answering.value}>{current.prompt.options.map((option) => <option value={option.id}>{option.label}</option>)}</select>
								: <input class="input" id="login-answer" name="answer" type={current.prompt.kind === "secret" ? "password" : "text"}
									placeholder={current.prompt.placeholder} autocomplete="off" spellcheck="false" disabled={answering.value} />}
						</label>
						<button class="btn primary" id="login-continue" type="submit" disabled={answering.value}>{t("login.continue")}</button>
					</form>
				)}
				<button class="btn ghost" id="login-cancel" type="button" onClick={() => void props.controller.workspace?.cancelLogin({ id: current.id }, context).catch(toastError)}>{t("login.cancel")}</button>
			</>
		);
		return () => {
			const provider = props.provider;
			if (!provider?.oauth) return null;
			const current = session.value;
			return (
				<div class="login-card" id="provider-login">
					{current?.status === "pending" ? <><span class="login-title">{t("login.title")}</span>{pending(current)}</> : (
						<>
							{current?.status === "failed" && <p class="login-error" id="login-error" role="alert">{current.error === "http" ? t("login.error.http", current.httpStatus ?? "") : t(`login.error.${current.error ?? "unknown"}`)}</p>}
							{provider.auth === "oauth" ? (
								<>
									<div class="login-row"><span class="login-title">{t("login.title")}</span><span class="pill" data-on="true">{t("login.signedIn")}</span></div>
									<button class="btn" id="login-out" type="button" disabled={busy.value} onClick={() => signOut(provider)}>{t("login.signOut")}</button>
								</>
							) : (
								<>
									<span class="login-title">{t("login.title")}</span>
									<button class="btn" id="login-start" type="button" disabled={busy.value} onClick={() => start(provider)}><Icon name="key" size={14} />{provider.oauth.label}</button>
								</>
							)}
						</>
					)}
				</div>
			);
		};
	},
});
