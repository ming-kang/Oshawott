import type { ThinkingLevel, Workspace } from "../../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../../lib/chord.ts";
import { ext } from "../../platform/webext.ts";
import { t } from "../i18n/index.ts";
import { click, control, input, until } from "./dom.ts";

export { click, control, input, until };

type Step = { name: string; ok: boolean; detail?: string };
type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>, "providers" | "defaultModel" | "setDefaultConfiguration">;
const context = BACKGROUND_CONTEXT;
/** Chooses a built-in provider in the add-provider editor's searchable list. */
export async function pickBuiltin(id: string) {
	const option = await until(() => control<HTMLElement>(`#builtin-provider-list [data-provider="${id}"]`));
	option.click();
}

export async function testModelManagement(source: Source, origin: string): Promise<Step[]> {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail = "") => steps.push({ name, ok, ...(detail ? { detail } : {}) });
	let customId: string | undefined;
	let phase = "opening settings";
	const originalPermission = ext.permissions.request;
	// WebDriver cannot produce a trusted click inside Firefox's sidebar. Real user clicks still take the production path.
	if (navigator.userAgent.includes("Firefox")) ext.permissions.request = async () => true;
	try {
		click("#settings-toggle");
		click("#add-provider");
		click("#provider-kind-custom");
		input("#provider-name", "Local test service");
		input("#provider-base-url", `${origin.replace(/\/+$/, "")}/v1`);
		const api = control<HTMLSelectElement>("#provider-api")!;
		api.value = "openai-completions";
		api.dispatchEvent(new Event("change", { bubbles: true }));
		input("#provider-key", "local-key");
		click("#provider-refresh");
		phase = "probing and selecting custom provider models";
		const reasoningBox = await until(() => control<HTMLInputElement>('#provider-fetch-list [data-model="local-reasoning"] input[type="checkbox"]'));
		const unusedRow = control('#provider-fetch-list [data-model="local-unused"]');
		step("probing shows a selectable checklist without auto-saving the provider", Boolean(unusedRow)
			&& !source.providers.value.some((provider) => provider.name === "Local test service"));
		reasoningBox.click();
		click("#provider-import-models");
		await until(() => control('#provider-manual-models [data-model="local-reasoning"]') ? true : undefined);
		step("importing adds only the checked model to the draft list", !control('#provider-manual-models [data-model="local-unused"]'));

		click("#provider-save");
		phase = "saving the custom provider";
		const local = await until(() => source.providers.value.find((item) => item.name === "Local test service" && item.configured));
		customId = local.id;
		step("custom provider saves only the selected visual and reasoning model", local.models.some((model) => model.id === "local-reasoning" && model.vision && model.thinkingLevels.includes("high"))
			&& !local.models.some((model) => model.id === "local-unused"), `${local.models.map((model) => model.id).join(", ")}`);

		click(`.provider[data-provider="${customId}"] .provider-head`);
		click("#provider-refresh");
		phase = "re-probing an existing provider without re-entering the key";
		const alreadyAdded = await until(() => control<HTMLElement>('#provider-fetch-list [data-model="local-reasoning"][data-added="true"]'));
		step("re-probing reuses the stored key and marks already-added models", alreadyAdded.querySelector<HTMLInputElement>("input")?.disabled === true);
		click("#provider-fetch-cancel");

		phase = "testing Use built-in data on a custom model";
		click("#provider-add-model");
		const newModelEditor = control<HTMLDetailsElement>("#provider-manual-models details:last-child")!;
		const newIdInput = newModelEditor.querySelector<HTMLInputElement>('input[placeholder="model-id"]')!;
		newIdInput.value = "custom-sonnet";
		newIdInput.dispatchEvent(new Event("input", { bubbles: true }));
		newModelEditor.querySelector<HTMLButtonElement>(".model-use-builtin")!.click();
		const builtinSearch = newModelEditor.querySelector<HTMLInputElement>(".builtin-search")!;
		builtinSearch.value = "claude-sonnet";
		builtinSearch.dispatchEvent(new Event("input", { bubbles: true }));
		const candidate = await until(() => newModelEditor.querySelector<HTMLButtonElement>('.builtin-candidate-row[data-provider="anthropic"]') ?? newModelEditor.querySelector<HTMLButtonElement>(".builtin-candidate-row"));
		candidate.click();
		const ctxDiff = await until(() => newModelEditor.querySelector('.builtin-diff-row[data-field="contextWindow"]'));
		newModelEditor.querySelector<HTMLButtonElement>(".builtin-apply")!.click();
		const appliedVision = newModelEditor.querySelector<HTMLInputElement>(".vision-check input")?.checked === true;
		const appliedCtx = Number(newModelEditor.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]?.value);
		step("Use built-in data previews diffs and applies capabilities without changing model ID",
			Boolean(ctxDiff) && newIdInput.value === "custom-sonnet" && appliedVision && appliedCtx >= 200_000,
			`id=${newIdInput.value} ctx=${appliedCtx} vision=${appliedVision}`);
		newModelEditor.querySelector<HTMLButtonElement>(".btn.danger")?.click();

		input("#provider-name", "Local edited draft");
		click("#provider-save");
		phase = "saving the edited provider";
		await until(() => source.providers.value.find((provider) => provider.id === customId)?.name === "Local edited draft");
		step("provider edits persist without re-entering the API key", source.providers.value.find((provider) => provider.id === customId)?.configured === true);

		click("#new-chat");
		click("#model");
		input("#model-menu input", "local-reasoning");
		click('#model-menu .menu-item[data-model="local-reasoning"]');
		await until(() => !document.querySelector("#model-menu"));
		// The button follows the chosen model a moment after the model menu closes: click until its menu is there.
		await until(() => {
			if (!document.querySelector("#thinking-menu")) click("#thinking");
			return document.querySelector("#thinking-menu [data-level]") ?? undefined;
		});
		const effortOptions = [...document.querySelectorAll<HTMLElement>("#thinking-menu [data-level]")];
		step("Effort options use translated level labels under a heading", effortOptions.length > 0
			&& effortOptions.every((option) => option.textContent?.trim() === t(`thinking.level.${option.dataset.level as ThinkingLevel}`))
			&& control("#thinking-menu-title")?.textContent === t("thinking.menuTitle"));
		const effortAlignment = await until(() => {
			const menu = control<HTMLElement>("#thinking-menu")!.getBoundingClientRect();
			const button = document.querySelector<HTMLElement>("#thinking")!.getBoundingClientRect();
			return Math.abs(menu.right - button.right) <= 1 && menu.bottom <= button.top
				? `menu right=${menu.right}; button right=${button.right}` : undefined;
		});
		step("Effort menu aligns with its button", true, effortAlignment);
		click('#thinking-menu [data-level="high"]');
		await until(() => !document.querySelector("#thinking-menu"));
		await until(() => source.defaultModel.value?.provider === customId && document.querySelector<HTMLElement>("#thinking")?.dataset.level === "high"
			&& document.querySelector("#thinking .model-name")?.textContent === t("thinking.level.high"));
		step("model and thinking selections target the custom provider", true,
			`${JSON.stringify(source.defaultModel.value)}; ${document.querySelector("#model")?.textContent}; ${document.querySelector("#thinking")?.textContent}`);
		input("#prompt", "local protocol check");
		click("#send");
		phase = "sending a high-thinking request to the custom provider";
		const answer = await until(() => {
			if (document.body.dataset.busy !== "false") return undefined;
			const messages = [...document.querySelectorAll(".msg.assistant")];
			return messages.at(-1)?.textContent?.includes("reasoning=high") ? messages.at(-1)?.textContent : undefined;
		}, 30_000);
		step("custom OpenAI-compatible chat receives the selected thinking level", answer?.includes("model=local-reasoning") === true, answer?.slice(-160));

		click("#model");
		input("#model-menu input", "demo");
		click('#model-menu .menu-item[data-provider="demo"]');
		await until(() => source.defaultModel.value?.provider === "demo");
		click("#settings-toggle");
		click(`.provider[data-provider="${customId}"] .provider-head`);
		click("#provider-delete");
		click("#provider-delete");
		await until(() => !source.providers.value.some((provider) => provider.id === customId));
		step("provider deletion removes its runtime entry after chats switch models", !source.providers.value.some((provider) => provider.id === customId));
		customId = undefined;

		click("#add-provider");
		click("#provider-kind-custom");
		input("#provider-name", "Denied draft");
		input("#provider-base-url", "https://denied.example/v1");
		input("#provider-key", "denied-secret");
		const original = ext.permissions.request;
		ext.permissions.request = async () => false;
		try {
			click("#provider-save");
			await new Promise((resolve) => setTimeout(resolve, 100));
			step("permission denial keeps drafts and saves neither provider nor key", control<HTMLInputElement>("#provider-name")?.value === "Denied draft"
				&& !source.providers.value.some((provider) => provider.baseUrl.includes("denied.example")));
		} finally {
			ext.permissions.request = original;
		}
		click("#provider-back");
		click("#settings-back");
	} catch (error) {
		const diagnostic = phase === "saving the edited provider"
			? `; name=${document.querySelector<HTMLInputElement>("#provider-name")?.value}; disabled=${document.querySelector<HTMLButtonElement>("#provider-save")?.disabled}; busy=${document.querySelector<HTMLButtonElement>("#provider-save")?.getAttribute("aria-busy")}; toasts=${[...document.querySelectorAll(".toast")].map((node) => node.textContent).join(" | ")}; providers=${source.providers.value.filter((provider) => provider.kind === "custom").map((provider) => `${provider.name}:${provider.discoveryError ?? ""}`).join(" | ")}`
			: "";
		const conversation = phase === "sending a high-thinking request to the custom provider"
			? `; default=${JSON.stringify(source.defaultModel.value)}; model=${document.querySelector("#model")?.textContent}; thinking=${document.querySelector("#thinking")?.textContent}; toasts=${[...document.querySelectorAll(".toast")].map((node) => node.textContent).join(" | ")}; assistant=${[...document.querySelectorAll(".msg.assistant")].at(-1)?.textContent}`
			: "";
		step("model management browser flow", false, `${phase}: ${String(error)}${diagnostic}${conversation}`);
	} finally {
		ext.permissions.request = originalPermission;
		const demo = source.providers.value.flatMap((provider) => provider.models.filter((model) => provider.id === "demo").map((model) => ({ provider: provider.id, modelId: model.id })))[0];
		if (demo) await source.setDefaultConfiguration({ model: demo, thinkingLevel: "off" as ThinkingLevel }, context).catch(() => null);
		for (let index = 0; index < 3 && document.querySelector(".overlay:not(.leaving)"); index++) {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
	}
	return steps;
}
