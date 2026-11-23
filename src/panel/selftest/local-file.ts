import { ext } from "../../platform/webext.ts";
import { until } from "./dom.ts";
import type { PageCall } from "./page-tools.ts";

type Step = { name: string; ok: boolean; detail?: string };
const TITLE = "Oshawott local document";
const TEXT = "Local file smoke marker";

/** An already-open local document through the real Broker and Page, plus the Panel's target availability. */
export async function testLocalFilePage(origin: string, call: PageCall): Promise<Step[]> {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, ...(detail ? { detail } : {}) });
	let restore: number | undefined;
	let panel: number | undefined;
	try {
		const tabs = await ext.tabs.query({});
		const local = tabs.find((tab) => tab.url?.startsWith("file:"));
		restore = tabs.find((tab) => tab.url?.startsWith(origin))?.id;
		panel = tabs.find((tab) => tab.url?.startsWith(ext.runtime.getURL("panel.html")))?.id;
		if (local?.id === undefined || !local.url) throw new Error("No already-open file:// tab");
		await ext.tabs.update(local.id, { active: true });
		const snapshot = await call(local.id, "page_snapshot", {});
		const inspected = await call(local.id, "page_inspect", { selector: "main", include: ["html"] });
		step(
			"an already-open file:// document supports snapshot and inspect",
			snapshot.url === local.url && snapshot.title === TITLE && snapshot.text.includes(TEXT)
				&& inspected.elements[0]?.html.includes(TEXT),
			`${snapshot.title}: ${snapshot.text}`,
		);
		const chip = await until(() => {
			const element = document.querySelector<HTMLElement>("#tab-chip");
			return element?.dataset.available === "true" && element.querySelector(".name")?.textContent === TITLE ? element : undefined;
		});
		step("the Panel makes an already-open local document the target", chip.title === local.url, chip.title);
	} catch (error) {
		step("local file scenario", false, String(error));
	} finally {
		if (restore !== undefined) {
			await ext.tabs.update(restore, { active: true }).catch(() => {});
			await until(() => document.querySelector("#tab-chip .name")?.textContent === "Oshawott test page" || undefined).catch(() => {});
		}
		// Leave the Panel visible without making the more-recent local tab its fallback target.
		if (panel !== undefined) await ext.tabs.update(panel, { active: true }).catch(() => {});
	}
	return steps;
}
