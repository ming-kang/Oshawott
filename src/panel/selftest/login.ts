import type { Workspace } from "../../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../../lib/chord.ts";
import { click, control, input, pickBuiltin, until } from "./models.ts";

type Step = { name: string; ok: boolean; detail?: string };
type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>, "providers" | "logins" | "removeCredential">;
const PROVIDER = "demo-account";

/** The account sign-in UI against the dev build's `demo-account` provider: no real account, the real Engine path. */
export async function testAccountLogin(source: Source): Promise<Step[]> {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail = "") => steps.push({ name, ok, ...(detail ? { detail } : {}) });
	const account = () => source.providers.value.find((provider) => provider.id === PROVIDER);
	let phase = "opening the provider editor";
	try {
		click("#settings-toggle");
		click("#add-provider");
		await pickBuiltin(PROVIDER);
		step("a sign-in-only provider offers no API key field", control<HTMLElement>("#provider-key")?.closest<HTMLElement>(".provider-field")?.hidden === true
			&& control<HTMLElement>("#provider-save")?.hidden === true);

		phase = "starting the sign-in";
		click("#login-start");
		const code = await until(() => control("#login-code")?.textContent);
		const link = control<HTMLAnchorElement>("#login-open");
		step("the device code and an HTTPS authorization link are shown", code === "DEMO-1234"
			&& link?.protocol === "https:" && link.target === "_blank", `${code} ${link?.href}`);
		step("the provider stays selected during sign-in", control<HTMLElement>("#builtin-provider-chosen")?.dataset.provider === PROVIDER
			&& control<HTMLElement>("#builtin-provider-chosen")?.hidden === false && control<HTMLElement>("#builtin-provider-change")?.hidden !== false);

		phase = "answering the code prompt";
		await until(() => control("#login-answer"));
		input("#login-answer", "demo");
		click("#login-continue");
		await until(() => account()?.auth === "oauth" && control("#login-out"));
		const row = await until(() => control(`#provider-discovered-models [data-model="demo-account"]`));
		step("signing in configures the provider and lists the account's models", account()?.configured === true && !row.querySelector("button"));
		const visible = JSON.stringify([source.logins.value, source.providers.value]) + document.body.textContent;
		step("no token reaches the panel", !/demo-(access|refresh)/.test(visible));

		phase = "signing out and cancelling a second sign-in";
		click("#login-out");
		await until(() => account()?.auth === null && control("#login-start"));
		click("#login-start");
		await until(() => control("#login-cancel"));
		click("#login-cancel");
		await until(() => source.logins.value.length === 0 && control("#login-start"));
		step("sign-out removes the credential and a cancelled sign-in leaves none", account()?.configured === false);
		click("#provider-back");
		click("#settings-back");
	} catch (error) {
		step("account sign-in browser flow", false, `${phase}: ${String(error)}; logins=${JSON.stringify(source.logins.value)}`);
	} finally {
		await source.removeCredential({ provider: PROVIDER }, BACKGROUND_CONTEXT).catch(() => null);
		for (let index = 0; index < 3 && document.querySelector(".overlay:not(.leaving)"); index++) {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	return steps;
}
