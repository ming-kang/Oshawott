// A dev build's self-test, run by the panel when it is opened as `panel.html?selftest=<origin>` (Firefox's WebDriver
// cannot reach extension pages, so the extension drives itself and reports to the test's server). The same steps as
// scripts/smoke-chromium.mjs: Engine state in the panel, page tools on the test tab, a prompt's run.
import { ext } from "../platform/webext.ts";

type Step = { name: string; ok: boolean; detail?: string };

const until = async <T>(read: () => T | undefined | Promise<T | undefined>, ms = 20_000): Promise<T> => {
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
	try {
		const providers = await until(() => {
			const values = all("#provider option").map((o) => (o as HTMLOptionElement).value);
			return values.length ? values : undefined;
		});
		step("panel ↔ Engine over a Port", providers.includes("anthropic"), providers.join(", "));

		// The Engine's devtools handle, in the event page (Firefox lets an extension page reach it).
		const background = (await (ext.runtime as unknown as { getBackgroundPage(): Promise<Window> }).getBackgroundPage()) as Window & {
			oshawatt: {
				page(tabId: number, tool: string, args: object): Promise<any>;
				codemode(code: string): Promise<{ ok: boolean; value?: unknown; output?: { text?: string }[] }>;
			};
		};
		const [tab] = await ext.tabs.query({});
		const target = (await ext.tabs.query({})).find((t) => t.url?.startsWith(origin)) ?? tab;
		const page = (tool: string, args: object) => background.oshawatt.page(target!.id!, tool, args);
		const snap = await page("page_snapshot", {});
		const input = snap.elements.find((e: { role: string }) => e.role.startsWith("input"));
		const button = snap.elements.find((e: { name: string }) => e.name === "Go");
		step("page_snapshot via Broker injection", snap.title === "Oshawatt test page" && !!input && !!button, `${snap.elements.length} elements`);
		await page("page_type", { ref: input.ref, text: "otters" });
		await page("page_click", { ref: button.ref });
		const after = await page("page_snapshot", {});
		step("page_type + page_click act on the page", after.text.includes("searched: otters"), after.text.split("\n").at(-1));

		const run = await background.oshawatt.codemode("text('hi from QuickJS'); return [1, 2, 3].map((n) => n * n)");
		step("code mode runs in a Worker", run.ok && JSON.stringify(run.value) === "[1,4,9]", `${JSON.stringify(run.value)} ${run.output?.[0]?.text ?? ""}`);

		document.getElementById("new")!.click();
		await until(() => (all("#chats option").length ? true : undefined));
		(document.getElementById("prompt") as HTMLTextAreaElement).value = "What is on this page?";
		document.getElementById("send")!.click();
		const note = await until(() => all(".msg").map((m) => m.textContent ?? "").find((t) => t.startsWith("Run ended")));
		step("prompt → Durable run → outcome in the panel", true, note);
	} catch (error) {
		step("self-test", false, String(error));
	}
	await fetch(`${origin}/report`, { method: "POST", body: JSON.stringify(steps) });
}
