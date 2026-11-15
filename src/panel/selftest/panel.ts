import type { Workspace } from "../../contracts/chat.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../../lib/chord.ts";
import { t } from "../i18n/index.ts";
import { click, until } from "./dom.ts";
import { testAccountLogin } from "./login.ts";
import { pickBuiltin, testModelManagement } from "./models.ts";
import { testVueComponents } from "./vue.tsx";
import { h } from "../ui.ts";

type Step = { name: string; ok: boolean; detail?: string };
type Source = Pick<Extract<Reference<typeof Workspace>, { variant: "owner" }>,
	"chats" | "createChat" | "deleteChat" | "renameChat" | "busyMode" | "setBusyMode" | "providers" | "defaultModel" | "setDefaultConfiguration"
	| "autoTitle" | "autoCompaction" | "autoRetry" | "confirmActions" | "setPreference"
	| "instructions" | "setInstructions" | "resetInstructions" | "logins" | "removeCredential"
>;

export async function testPanel(source: Source, origin?: string) {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, detail });
	const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

	// These keys are only saved and cleared locally; all model requests still use the demo provider.
	click("#settings-toggle");
	await until(() => document.activeElement?.id === "settings-back");
	step("settings opens as a named modal and receives focus", document.querySelector("#settings")?.getAttribute("aria-modal") === "true" && document.activeElement?.id === "settings-back" && document.querySelector("#settings-back")?.hasAttribute("aria-label") === true);
	const savedRows = [...document.querySelectorAll<HTMLElement>(".provider[data-provider]")];
	step("settings lists only saved providers as text rows", savedRows.length > 0 && savedRows.every((row) => {
		const provider = source.providers.value.find((item) => item.id === row.dataset.provider);
		return (provider?.kind === "custom" || provider?.configured === true) && !row.querySelector(".provider-mark");
	}), savedRows.map((row) => row.dataset.provider).join(", "));
	click("#add-provider");
	await until(() => document.querySelector("#builtin-provider-search"));
	const options = () => [...document.querySelectorAll<HTMLElement>("#builtin-provider-list [data-provider]")].map((option) => option.dataset.provider);
	const providerSearch = document.querySelector<HTMLInputElement>("#builtin-provider-search")!;
	step("a built-in provider must be chosen before its key field or Save appear", options().length > 1
		&& !document.querySelector("#provider-key") && !document.querySelector("#provider-save"));
	providerSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
	await until(() => document.querySelector<HTMLElement>("#builtin-provider-list .provider-option.active")?.dataset.provider === options().at(-1));
	const endProvider = document.querySelector<HTMLElement>("#builtin-provider-list .provider-option.active")?.dataset.provider;
	providerSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
	await until(() => document.querySelector<HTMLElement>("#builtin-provider-list .provider-option.active")?.dataset.provider === options()[0]);
	const homeProvider = document.querySelector<HTMLElement>("#builtin-provider-list .provider-option.active")?.dataset.provider;
	step("the provider combobox supports Home and End through the shared navigation", endProvider === options().at(-1) && homeProvider === options()[0]);
	providerSearch.value = "groq";
	providerSearch.dispatchEvent(new Event("input", { bubbles: true }));
	await until(() => options().length === 1 && options()[0] === "groq");
	step("the built-in provider search filters by name", options().includes("groq") && !options().includes("anthropic"), options().join(","));
	await pickBuiltin("groq");
	step("the built-in provider list reveals additional Pi-AI providers", document.querySelector("#builtin-provider-chosen .provider-chosen-name")?.textContent === "Groq"
		&& !document.querySelector(".provider-picker") && !document.querySelector('.provider[data-provider="groq"]'));
	click("#provider-kind-custom");
	await until(() => document.querySelector("#provider-name"));
	click("#provider-kind-builtin");
	await until(() => document.querySelector("#builtin-provider-change"));
	click("#builtin-provider-change");
	await pickBuiltin("anthropic");
	const input = document.querySelector<HTMLInputElement>("#provider-key")!;
	input.value = "panel-smoke-key";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	click("#provider-save");
	await until(() => source.providers.value.find((provider) => provider.id === "anthropic")?.configured === true
		&& Boolean(document.querySelector('.provider[data-provider="anthropic"] [data-on]')));
	step("saving a built-in provider adds a configured text row", !document.querySelector('.provider[data-provider="anthropic"] .provider-mark'));
	click('.provider[data-provider="anthropic"] .provider-head');
	await until(() => document.querySelector("#provider-delete"));
	step("settings refresh after saving a key without exposing it", document.querySelector<HTMLInputElement>("#provider-key")?.value === "");
	click("#provider-delete");
	await until(() => source.providers.value.find((provider) => provider.id === "anthropic")?.configured === false
		&& !document.querySelector('.provider[data-provider="anthropic"]'));
	step("removing a built-in key hides its row", true);
	const defaultDelivery = source.busyMode.value === "steer" && document.querySelector('#settings-delivery [data-value="steer"]')?.getAttribute("aria-checked") === "true";
	click('#settings-delivery [data-value="followUp"]');
	await until(() => source.busyMode.value === "followUp" && document.querySelector<HTMLElement>("#send-mode")?.dataset.mode === "followUp");
	step("delivery defaults to Steer and Settings updates the composer preference", defaultDelivery && document.querySelector('#settings-delivery [data-value="followUp"]')?.getAttribute("aria-checked") === "true");
	click('#settings-delivery [data-value="steer"]');
	await until(() => source.busyMode.value === "steer" && document.querySelector<HTMLElement>("#send-mode")?.dataset.mode === "steer");
	const defaultTitlePreference = source.autoTitle.value === false && !document.querySelector<HTMLInputElement>("#settings-autoTitle")?.checked;
	click("#settings-autoTitle");
	await until(() => source.autoTitle.value && document.querySelector<HTMLInputElement>("#settings-autoTitle")?.checked === true);
	click("#settings-autoTitle");
	await until(() => !source.autoTitle.value);
	click("#settings-autoCompaction");
	await until(() => !source.autoCompaction.value);
	click("#settings-autoRetry");
	await until(() => !source.autoRetry.value);
	click("#settings-autoCompaction");
	await until(() => source.autoCompaction.value);
	click("#settings-autoRetry");
	await until(() => source.autoRetry.value);
	step("conversation preferences default safely and round-trip through native checkboxes", defaultTitlePreference && source.autoCompaction.value && source.autoRetry.value);
	const defaultConfirm = !source.confirmActions.value && !document.querySelector<HTMLInputElement>("#settings-confirmActions")?.checked;
	click("#settings-confirmActions");
	await until(() => source.confirmActions.value && document.querySelector<HTMLInputElement>("#settings-confirmActions")?.checked === true);
	click("#settings-confirmActions");
	await until(() => !source.confirmActions.value);
	step("asking before page actions is off by default and round-trips through its checkbox", defaultConfirm);
	const originalInstructions = source.instructions.value;
	const instructions = document.querySelector<HTMLTextAreaElement>("#settings-instructions")!;
	const details = document.querySelector<HTMLDetailsElement>("#settings-instructions-details")!;
	step("global instructions start collapsed with a one-line preview", !details.open && details.contains(instructions)
		&& Boolean(document.querySelector("#settings-instructions-preview")?.textContent));
	details.open = true;
	instructions.value = "Panel smoke unsaved instructions";
	instructions.dispatchEvent(new Event("input", { bubbles: true }));
	await source.setInstructions({ instructions: "Other panel instructions" }, BACKGROUND_CONTEXT);
	await until(() => document.querySelector<HTMLElement>("#settings-instructions-status")?.hidden === false);
	step("external instructions changes preserve unsaved edits and offer an accessible reload", instructions.value === "Panel smoke unsaved instructions"
		&& document.querySelector("#settings-instructions-status")?.getAttribute("role") === "status"
		&& document.querySelector("#settings-instructions-status")?.textContent?.includes(t("settings.instructionsChangedElsewhere")) === true);
	click("#instructions-load-latest");
	await until(() => instructions.value === "Other panel instructions" && !document.querySelector("#settings-instructions-status"));
	step("loading the latest instructions explicitly discards the local draft", instructions.value === "Other panel instructions" && !document.querySelector("#settings-instructions-status"));
	instructions.value = "Panel smoke instructions";
	instructions.dispatchEvent(new Event("input", { bubbles: true }));
	click("#instructions-save");
	await until(() => source.instructions.value === "Panel smoke instructions" && document.querySelector<HTMLButtonElement>("#instructions-save")?.disabled === false);
	click("#instructions-restore");
	click("#instructions-restore");
	await until(() => source.instructions.value === originalInstructions && instructions.value === originalInstructions);
	step("global instructions save and restore without clobbering their editor", true);
	instructions.value = " \n\t ";
	instructions.dispatchEvent(new Event("input", { bubbles: true }));
	click("#instructions-save");
	await until(() => source.instructions.value === originalInstructions && instructions.value === originalInstructions && document.querySelector<HTMLButtonElement>("#instructions-save")?.disabled === false);
	step("whitespace-only instructions saves settle to the built-in text", true);
	const theme = document.documentElement.dataset.theme ?? "system";
	click('#settings [data-value="dark"]');
	await until(() => document.documentElement.dataset.theme === "dark" && document.querySelector('#settings [data-value="dark"]')?.getAttribute("aria-checked") === "true");
	step("appearance stays owned by Settings", document.documentElement.dataset.theme === "dark" && document.querySelector('#settings [data-value="dark"]')?.getAttribute("aria-checked") === "true");
	document.querySelector('#settings [data-value="dark"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
	await until(() => document.documentElement.dataset.theme === "system" && document.querySelector('#settings [data-value="system"]')?.getAttribute("aria-checked") === "true");
	step("appearance radios support arrow keys and roving focus", document.documentElement.dataset.theme === "system" && (document.activeElement as HTMLElement)?.dataset.value === "system" && document.querySelector('#settings [data-value="system"]')?.getAttribute("aria-checked") === "true");
	click(`#settings [data-value="${theme}"]`);
	const languages = [...document.querySelectorAll<HTMLElement>("#settings-language [data-value]")];
	step("settings offers system language, Chinese and English with the current preference selected", languages.map((item) => item.dataset.value).join(",") === "system,zh-CN,en"
		&& languages.slice(1).map((item) => item.textContent).join(",") === "中文,English"
		&& languages.filter((item) => item.getAttribute("aria-checked") === "true").length === 1);
	click("#settings-back");
	await until(() => !document.querySelector("#settings"));

	// Exercise the menu action independently of its busy-only visibility: both controls own the same durable preference.
	click("#send-mode");
	await until(() => document.querySelector(".send-mode-menu"));
	click('.send-mode-menu [data-mode="followUp"]');
	await until(() => source.busyMode.value === "followUp" && document.querySelector<HTMLElement>("#send-mode")?.dataset.mode === "followUp");
	click("#settings-toggle");
	await until(() => document.querySelector("#settings"));
	step("the composer delivery menu updates the same preference shown in Settings", document.querySelector('#settings-delivery [data-value="followUp"]')?.getAttribute("aria-checked") === "true");
	click('#settings-delivery [data-value="steer"]');
	await until(() => source.busyMode.value === "steer" && document.querySelector<HTMLElement>("#send-mode")?.dataset.mode === "steer");
	click("#settings-back");
	await until(() => !document.querySelector("#settings"));

	click("#chats-toggle");
	await until(() => document.querySelector("#chat-drawer")?.contains(document.activeElement));
	step("chat rows are buttons inside a focus-managed dialog", document.querySelector("#chat-drawer")?.getAttribute("role") === "dialog" && document.querySelector(".chat-select") instanceof HTMLButtonElement && document.querySelector("#chat-drawer")?.contains(document.activeElement) === true);
	const chatSelect = document.querySelector<HTMLElement>(".chat-select")!;
	const chatRow = chatSelect.closest<HTMLElement>(".chat-item")!;
	// The drawer slides in and the actions rise: measure the resting layout. A running chat's pulse never finishes.
	const settled = () => Promise.all(document.querySelector("#chat-drawer")!.getAnimations({ subtree: true })
		.filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished));
	await settled();
	const idleSelect = chatSelect.getBoundingClientRect();
	chatRow.querySelector<HTMLButtonElement>('[data-action="more"]')!.click();
	const chatActions = await until(() => chatRow.querySelector<HTMLElement>(".chat-actions"));
	await settled();
	const openSelect = chatSelect.getBoundingClientRect();
	const actionsRect = chatActions.getBoundingClientRect();
	const rowRect = chatRow.getBoundingClientRect();
	step("opening a chat's menu leaves its title in place and keeps the actions inside the row",
		idleSelect.left === openSelect.left && idleSelect.top === openSelect.top && idleSelect.width === openSelect.width
		&& actionsRect.top >= openSelect.bottom && actionsRect.right <= rowRect.right && actionsRect.bottom <= rowRect.bottom,
		JSON.stringify({ idle: idleSelect, open: openSelect, actions: actionsRect }));
	const openMenu = async (id: number | undefined) => {
		const row = `.chat-item[data-id="${id}"]`;
		if (!document.querySelector(`${row} .chat-actions`)) click(`${row} [data-action="more"]`);
		await until(() => document.querySelector(`${row} [data-action="rename"]`));
	};
	const renamedId = source.chats.value[0]?.id;
	const originalTitle = source.chats.value[0]?.title ?? "";
	const renamedRow = document.querySelector(`.chat-item[data-id="${renamedId}"]`);
	await openMenu(renamedId);
	click(`.chat-item[data-id="${renamedId}"] [data-action="rename"]`);
	await until(() => document.querySelector(".rename-input"));
	const rename = document.querySelector<HTMLInputElement>(".rename-input")!;
	rename.value = "Panel smoke title";
	rename.dispatchEvent(new Event("input", { bubbles: true }));
	rename.focus();
	rename.setSelectionRange(6, 11);
	const resetId = await source.createChat({ title: "Panel smoke reset" }, BACKGROUND_CONTEXT);
	await until(() => document.querySelector(`.chat-item[data-id="${resetId}"] [data-action="more"]`) !== null);
	// Two days on, this update moves every row out of "today": a row that changes day group must keep its state.
	const realNow = Date.now;
	Date.now = () => realNow() + 2 * 86_400_000;
	let regrouped = false;
	try {
		await source.renameChat({ id: resetId, title: "Panel smoke reset updated" }, BACKGROUND_CONTEXT);
		await until(() => document.querySelector(`.chat-item[data-id="${resetId}"] .chat-title`)?.textContent === "Panel smoke reset updated");
		regrouped = document.querySelector("#chat-drawer h3")?.textContent === t("chat.group.week");
	} finally { Date.now = realNow; }
	step("live chat updates preserve row identity, rename drafts and the caret across day groups", regrouped && document.querySelector(`.chat-item[data-id="${renamedId}"]`) === renamedRow
		&& document.querySelector(".rename-input") === rename && rename.value === "Panel smoke title"
		&& document.activeElement === rename && rename.selectionStart === 6 && rename.selectionEnd === 11);
	click('[data-action="save"]');
	await until(() => source.chats.value.find((chat) => chat.id === renamedId)?.title === "Panel smoke title" && !document.querySelector(".rename-input"));
	await source.renameChat({ id: renamedId!, title: originalTitle }, BACKGROUND_CONTEXT);
	step("chat titles can be edited inline without leaving the drawer", document.querySelector("#chat-drawer") !== null);
	await openMenu(resetId);
	const reset = document.querySelector<HTMLButtonElement>(`.chat-item[data-id="${resetId}"] [data-action="reset"]`)!;
	click(`.chat-item[data-id="${resetId}"] [data-action="reset"]`);
	await until(() => reset.hasAttribute("data-confirm"));
	const requiresConfirm = reset.hasAttribute("data-confirm") && !reset.disabled;
	click(`.chat-item[data-id="${resetId}"] [data-action="reset"]`);
	await until(() => !reset.disabled && !reset.hasAttribute("data-confirm"));
	step("resetting a background chat keeps its row and focus-managed controls", source.chats.value.some((chat) => chat.id === resetId));
	step("reset requires confirmation and returns to its idle label after completion", requiresConfirm && !reset.hasAttribute("data-confirm")
		&& document.querySelector(`.chat-item[data-id="${resetId}"] [data-action="reset"]`) === reset);
	click(`.chat-item[data-id="${resetId}"] [data-action="rename"]`);
	await until(() => document.querySelector(".rename-input"));
	await source.deleteChat({ id: resetId }, BACKGROUND_CONTEXT);
	await until(() => !document.querySelector(`.chat-item[data-id="${resetId}"]`));
	step("a renamed chat removed elsewhere drops its draft and focuses a surviving control", !document.querySelector(".rename-input")
		&& Boolean(document.activeElement?.closest("#chat-drawer") && document.activeElement.matches("button")),
		JSON.stringify({ active: document.activeElement?.outerHTML?.slice(0, 240), rows: document.querySelectorAll(".chat-item").length }));
	escape();
	await until(() => !document.querySelector("#chat-drawer"));

	click("#model");
	await until(() => document.querySelector("#model-menu"));
	// Like Effort, the picker hugs its button and may overlap the composer instead of clearing it;
	// poll past the entrance animation before measuring.
	const modelAlignment = await until(() => {
		const menu = document.querySelector("#model-menu")!.getBoundingClientRect();
		const button = document.querySelector("#model")!.getBoundingClientRect();
		const inside = menu.left >= 0 && menu.right <= innerWidth && menu.top >= 0 && menu.bottom <= innerHeight;
		return Math.abs(menu.left - button.left) <= 1 && Math.abs(button.top - menu.bottom - 8) <= 1 && inside
			? `menu left=${menu.left}; button left=${button.left}; gap=${button.top - menu.bottom}` : undefined;
	});
	step("the model menu hugs its button and stays inside the viewport", true, modelAlignment);
	const search = document.querySelector<HTMLInputElement>("#model-menu input")!;
	search.value = "demo";
	search.dispatchEvent(new Event("input"));
	await until(() => {
		const items = [...document.querySelectorAll<HTMLElement>("#model-menu .menu-item")];
		return items.length > 0 && items.every((item) => item.dataset.provider === "demo");
	});
	const choices = [...document.querySelectorAll<HTMLElement>("#model-menu .menu-item")];
	step("model menu filters the shared provider state", choices.length > 0 && choices.every((item) => item.dataset.provider === "demo"));
	step("model combobox exposes its active option", choices.every((item) => item.tabIndex === -1) && search.getAttribute("aria-activedescendant") === choices.find((item) => item.classList.contains("active"))?.id);
	search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	await until(() => !document.querySelector("#model-menu"));
	click("#model");
	await until(() => document.querySelector("#model-menu"));
	click("#settings-toggle");
	await until(() => document.querySelector("#settings"));
	step("opening a sheet replaces the model menu", !document.querySelector("#model-menu") && document.querySelectorAll(".overlay:not(.leaving)").length === 1);
	escape();
	await until(() => !document.querySelector(".overlay:not(.leaving)"));
	step("Escape restores the active overlay's trigger focus", document.activeElement?.id === "settings-toggle" && !document.querySelector(".overlay:not(.leaving)"),
		JSON.stringify({ active: document.activeElement?.id, overlays: document.querySelectorAll(".overlay:not(.leaving)").length }));
	await until(() => !document.querySelector("#settings"));

	const modelIcon = document.querySelector("#model svg");
	const sendIcon = document.querySelector("#send svg");
	const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
	const originalPrompt = prompt.value;
	for (const value of ["first", "second", originalPrompt]) {
		prompt.value = value;
		prompt.dispatchEvent(new Event("input"));
	}
	step("unchanged composer presentation keeps its button subtrees", Boolean(modelIcon && sendIcon) && document.querySelector("#model svg") === modelIcon && document.querySelector("#send svg") === sendIcon);

	click("#files-toggle");
	await until(() => document.querySelector("#files .file-list")?.getAttribute("aria-busy") === "false");
	const list = document.querySelector("#files .file-list")!;
	let refreshes = 0;
	const observer = new MutationObserver((records) => { refreshes += records.length; });
	observer.observe(list, { attributes: true, attributeFilter: ["aria-busy"] });
	let backgroundId: number | undefined;
	try {
		backgroundId = await source.createChat({ title: "Background refresh check" }, BACKGROUND_CONTEXT);
		await until(() => source.chats.value.some((chat) => chat.id === backgroundId));
		await source.deleteChat({ id: backgroundId }, BACKGROUND_CONTEXT);
		await until(() => !source.chats.value.some((chat) => chat.id === backgroundId));
		backgroundId = undefined;
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		step("unrelated workspace changes do not re-query the file sheet", refreshes === 0);
	} finally {
		observer.disconnect();
		if (backgroundId !== undefined) await source.deleteChat({ id: backgroundId }, BACKGROUND_CONTEXT);
		click("#files-back");
		await until(() => !document.querySelector("#files"));
	}

	const fixture = h("div");
	document.body.append(fixture);
	try {
		await testVueComponents(fixture, step, escape);
	} finally {
		fixture.remove();
	}
	if (origin) steps.push(...await testModelManagement(source, origin), ...await testAccountLogin(source));
	return steps;
}
