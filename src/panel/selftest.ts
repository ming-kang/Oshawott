// A dev build's self-test, run by the panel when it is opened as `panel.html?selftest=<origin>` (Firefox's WebDriver
// cannot reach extension pages, so the extension drives itself and reports to the test's server). The same steps as
// scripts/smoke-chromium.mjs, through the panel's UI: Engine state in Settings, page tools on the test tab, and a turn
// of the demo model (page_snapshot on the tab, then its answer).
import { ext } from "../platform/webext.ts";

type Step = { name: string; ok: boolean; detail?: string };

const until = async <T>(read: () => T | undefined | null | Promise<T | undefined | null>, ms = 20_000): Promise<T> => {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 200));
	}
};

export async function selftest(origin: string) {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, ...(detail ? { detail } : {}) });
	const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
	const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
	try {
		click("#settings-toggle");
		const providers = await until(() => {
			const ids = all(".provider[data-provider]").map((row) => row.dataset.provider!);
			return ids.length ? ids : undefined;
		});
		click("#settings-back");
		step("panel ↔ Engine over a Port", providers.includes("anthropic") && providers.includes("demo"), providers.join(", "));

		// The Engine's devtools handle, in the event page (Firefox lets an extension page reach it).
		const background = (await (ext.runtime as unknown as { getBackgroundPage(): Promise<Window> }).getBackgroundPage()) as Window & {
			oshawatt: {
				page(tabId: number, tool: string, args: object): Promise<any>;
				codemode(code: string): Promise<{ ok: boolean; value?: unknown; output?: { text?: string }[] }>;
			};
		};
		const target = (await ext.tabs.query({})).find((t) => t.url?.startsWith(origin));
		const chip = await until(() => document.querySelector("#tab-chip .name")?.textContent);
		const page = (tool: string, args: object) => background.oshawatt.page(target!.id!, tool, args);
		const snap = await page("page_snapshot", {});
		const input = snap.elements.find((e: { role: string }) => e.role.startsWith("input"));
		const button = snap.elements.find((e: { name: string }) => e.name === "Go");
		step(
			"page_snapshot via Broker injection",
			snap.title === "Oshawatt test page" && !!input && !!button,
			`${snap.elements.length} elements; panel targets “${chip}”`,
		);
		await page("page_type", { ref: input.ref, text: "otters" });
		await page("page_click", { ref: button.ref });
		const after = await page("page_snapshot", {});
		step("page_type + page_click act on the page", after.text.includes("searched: otters"), after.text.split("\n").at(-1));

		const run = await background.oshawatt.codemode("text('hi from QuickJS'); return [1, 2, 3].map((n) => n * n)");
		step("code mode runs in a Worker", run.ok && JSON.stringify(run.value) === "[1,4,9]", `${JSON.stringify(run.value)} ${run.output?.[0]?.text ?? ""}`);

		const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
		prompt.value = "What is on this page?";
		prompt.dispatchEvent(new Event("input"));
		click("#send");
		// The committed answer: a heading, and nothing streaming any more.
		const heading = await until(
			() => (document.querySelector(".msg.assistant[data-live]") ? undefined : all(".msg.assistant .md :is(h2, h3)").at(-1)?.textContent),
			30_000,
		);
		const tool = document.querySelector<HTMLElement>('.tool[data-tool="page_snapshot"]');
		step(
			"prompt → page_snapshot on the tab → answer streamed into the panel",
			heading === "Oshawatt test page" && tool?.dataset.status === "done",
			`“${heading}”; tool ${tool?.dataset.status}: ${tool?.querySelector(".tool-meta")?.textContent ?? ""}`,
		);
	} catch (error) {
		step("self-test", false, String(error));
	}
	// What the panel looks like here, for a person to check (dist/smoke-firefox-panel.png).
	const capture = (ext.tabs as unknown as { captureVisibleTab?(): Promise<string> }).captureVisibleTab;
	const screenshot = await capture?.call(ext.tabs).catch(() => undefined);
	await fetch(`${origin}/report`, { method: "POST", body: JSON.stringify({ steps, screenshot }) });
}
