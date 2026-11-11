import { ext } from "../platform/webext.ts";

type Step = { name: string; ok: boolean; detail?: string };
export type PageCall = (tabId: number, tool: string, args: object) => Promise<any>;

/** The page tools against a real tab: shared by both browsers' smoke tests. */
export async function testPageTools(origin: string, call: PageCall): Promise<Step[]> {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, ...(detail ? { detail } : {}) });
	const base = origin.replace(/\/$/, "");
	let tabId: number | undefined;
	const page = (tool: string, args: object) => call(tabId!, tool, args);
	const rejection = (tool: string, args: object) => page(tool, args).then(() => "", (error: unknown) => String((error as Error)?.message ?? error).split("\n")[0]!);
	/** Loads `path` in the test tab; only its own completion counts, never an earlier load's. */
	const visit = async (path: string) => {
		const url = `${base}${path}`;
		let listener: Parameters<typeof ext.tabs.onUpdated.addListener>[0] | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				listener = (id, change, tab) => {
					if (id === tabId && change.status === "complete" && tab.url === url) resolve();
				};
				ext.tabs.onUpdated.addListener(listener);
				timer = setTimeout(() => reject(new Error(`${url} did not load`)), 15_000);
				void ext.tabs.update(tabId!, { url }).catch(reject);
			});
		} finally {
			clearTimeout(timer);
			if (listener) ext.tabs.onUpdated.removeListener(listener);
		}
	};
	const button = (snapshot: { elements: { ref: string; name: string }[] }, name: string) => snapshot.elements.find((each) => each.name === name)!.ref;
	const counter = async () => (await page("page_inspect", { selector: "#n", include: ["html"] })).elements[0].html as string;

	try {
		tabId = (await ext.tabs.create({ url: "about:blank", active: false })).id;
		await visit("/inspect");
		const full = await page("page_snapshot", { structure: true });
		const scores = full.structure.tables.find((each: { caption?: string }) => each.caption === "Scores");
		step("structure extracts a bounded table", scores?.headers.join() === "Name,Score" && scores.rows.length === 50 && scores.rows[0].join() === "row 0,0" && !JSON.stringify(scores).includes("hidden row") && scores.truncated === true, `${scores?.rows.length} rows`);
		const aria = full.structure.tables.find((each: { headers: string[] }) => each.headers[0] === "Col");
		step("structure extracts an ARIA grid", aria?.rows[0]?.[0] === "aria-cell");
		const fruits = full.structure.lists.filter((each: { kind: string }) => each.kind === "ul");
		const terms = full.structure.lists.find((each: { kind: string }) => each.kind === "dl");
		step("structure extracts visible items of outer lists and definition lists", fruits.length === 1 && fruits[0].items.join("|") === "Apple Green|Pear" && terms?.items.join("|") === "Term: Definition|Other: Second", `${JSON.stringify(fruits[0]?.items)} ${JSON.stringify(terms?.items)}`);

		const scoped = await page("page_snapshot", { selector: "#scope", structure: true });
		const names = scoped.elements.map((each: { name: string }) => each.name);
		step("a selector snapshot returns only its subtree", scoped.text.includes("Inside region") && !scoped.text.includes("Outside region") && names.join() === "Inside" && scoped.structure.tables.length === 1 && scoped.structure.tables[0].rows[0][0] === "scoped-cell" && scoped.structure.lists.length === 0, names.join());
		const fresh = await page("page_snapshot", {});
		const byRef = await page("page_inspect", { selector: "#scope", include: ["box"] });
		const refScoped = await page("page_snapshot", { ref: byRef.elements[0].ref });
		step("a ref snapshot returns only its subtree", !refScoped.text.includes("Outside region") && fresh.text.includes("Outside region"));

		await page("page_click", { ref: button(await page("page_snapshot", {}), "Add") });
		const dynamic = (await page("page_inspect", { selector: "#dyn" })).elements[0];
		step("page_inspect reads a dynamic element", dynamic?.attributes["data-x"] === "made" && dynamic.styles.color === "rgb(1, 2, 3)" && dynamic.box.height === 30 && dynamic.html.includes("made") && dynamic.visible === true, JSON.stringify(dynamic?.box));
		const custom = (await page("page_inspect", { selector: "#dyn", include: ["styles"], styles: ["height"] })).elements[0];
		step("page_inspect returns only the requested parts", Object.keys(custom.styles).join() === "height" && custom.html === undefined && custom.attributes === undefined && custom.box === undefined);
		const long = await page("page_inspect", { selector: "#long", maxHtml: 100 });
		step("page_inspect truncates long HTML and attributes", long.elements[0].html.length === 100 && long.elements[0].attributes["data-long"].length === 500 && long.truncated === true);
		const many = await page("page_inspect", { selector: ".many", include: ["box"] });
		step("page_inspect bounds the elements returned", many.matched === 30 && many.elements.length === 5 && many.truncated === true, `${many.elements.length} of ${many.matched}`);
		const password = await page("page_inspect", { selector: "#login" });
		const field = await page("page_inspect", { selector: "#pw" });
		const leaked = ["hunter2", "template-secret", "nested-secret"].filter((secret) => JSON.stringify([password, field]).includes(secret));
		step("page_inspect redacts password values, also inside templates", !leaked.length && password.elements[0].html.includes("[redacted]") && field.elements[0].attributes.value === "[redacted]", leaked.join());
		const named = await page("page_inspect", { selector: "#named", include: ["attributes"] });
		step("page_inspect leaves out overlong attribute names", Object.keys(named.elements[0].attributes).join() === "id" && named.truncated === true && JSON.stringify(named).length < 2_000);
		step("page_inspect refuses an invalid selector", (await rejection("page_inspect", { selector: "[" })).includes("Invalid CSS selector"));

		const first = await page("page_snapshot", {});
		const stale = button(first, "Count");
		const second = await page("page_snapshot", {});
		const staleError = await rejection("page_click", { ref: stale });
		step("a new snapshot invalidates earlier refs", staleError.includes("earlier snapshot") && (await counter()).includes(">0<"), staleError);
		const inspected = (await page("page_inspect", { selector: "#count", include: ["box"] })).elements[0].ref;
		await page("page_click", { ref: inspected });
		step("a ref from page_inspect works with the other page tools", (await counter()).includes(">1<"));
		await page("page_click", { ref: button(second, "Hash") });
		await page("page_click", { ref: button(second, "Count") });
		step("a fragment change keeps refs", (await counter()).includes(">2<"));
		const bounced = await page("page_snapshot", {});
		await page("page_click", { ref: button(bounced, "Bounce") });
		const bounceError = await rejection("page_click", { ref: button(bounced, "Count") });
		step("leaving and returning to the URL still invalidates refs", bounceError.includes("navigated") && (await counter()).includes(">2<"), bounceError);
		const routed = await page("page_snapshot", {});
		await page("page_click", { ref: button(routed, "Route") });
		const routedError = await rejection("page_click", { ref: button(routed, "Count") });
		step("same-document navigation invalidates refs", routedError.includes("navigated") && (await counter()).includes(">2<"), routedError);

		const beforeLoad = button(await page("page_snapshot", {}), "Count");
		await visit("/inspect");
		await page("page_snapshot", {});
		const reloadError = await rejection("page_click", { ref: beforeLoad });
		step("a page load invalidates refs", reloadError.includes("earlier page load") && (await counter()).includes(">0<"), reloadError);

		await visit("/actions");
		type Seen = { ref: string; role: string; name: string; value?: string; checked?: boolean; disabled?: boolean; expanded?: boolean; href?: string };
		const see = async () => (await page("page_snapshot", {})).elements as Seen[];
		const control = (elements: Seen[], name: string) => elements.find((each) => each.name === name)!;
		const logged = async () => (await page("page_inspect", { selector: "#log", include: ["html"] })).elements[0].html as string;
		let seen = await see();
		step("a snapshot names controls by caption, label and image text", ["Size", "Query", "Search", "Picture link", "Agree", "Menu", "Rich"].every((name) => control(seen, name)), seen.map((each) => each.name).join("|"));
		step("a snapshot carries each control's state and never a password", control(seen, "Size").value === "Small" && control(seen, "Agree").checked === true
			&& control(seen, "Off").disabled === true && control(seen, "Menu").expanded === false && control(seen, "Picture link").href?.endsWith("#pic") === true
			&& !JSON.stringify(seen).includes("hunter2"), JSON.stringify(control(seen, "Size")));

		const typedIntoSelect = await rejection("page_type", { ref: control(seen, "Size").ref, text: "Medium" });
		await page("page_select", { ref: control(seen, "Size").ref, option: "Medium" });
		const missing = await rejection("page_select", { ref: control(seen, "Size").ref, option: "Large" });
		step("page_select chooses an option and page_type leaves a dropdown intact", typedIntoSelect.includes("page_select") && missing.includes("Small | Medium")
			&& (await logged()).includes("select:m") && control(await see(), "Size").value === "Medium", `${typedIntoSelect} / ${missing}`);

		seen = await see();
		await page("page_click", { ref: control(seen, "Menu").ref });
		const disabled = await rejection("page_click", { ref: control(seen, "Off").ref });
		await page("page_click", { ref: control(seen, "Agree").ref });
		const afterClicks = await see();
		step("page_click presses and releases like a pointer, and refuses a disabled control", (await logged()).includes("pointerdown mousedown click")
			&& control(afterClicks, "Menu").expanded === true && control(afterClicks, "Agree").checked === false && disabled.includes("disabled"), disabled);

		await page("page_hover", { ref: control(afterClicks, "Hover me").ref });
		await page("page_type", { ref: control(afterClicks, "Query").ref, text: "otter", submit: true });
		await page("page_press", { key: "a", ref: control(afterClicks, "Keys").ref, modifiers: ["Shift"] });
		await page("page_type", { ref: control(afterClicks, "Query").ref, text: "seal" });
		await page("page_press", { key: "Enter", ref: control(afterClicks, "Query").ref });
		const actions = await logged();
		step("hover, typed Enter and key presses reach the page", actions.includes("hover") && actions.includes("submit:otter") && actions.includes("key:a+shift") && actions.includes("submit:seal"), actions);

		await page("page_type", { ref: control(afterClicks, "Rich").ref, text: "new text" });
		const rich = (await page("page_inspect", { selector: "#rich", include: ["html"] })).elements[0].html as string;
		step("page_type replaces the content of an editable element", rich.includes(">new text<"), rich);

		await page("page_click", { ref: control(afterClicks, "Later").ref });
		const arrived = await page("page_wait", { text: "Arrived" });
		const never = await page("page_wait", { selector: "#never", timeoutMs: 200 });
		const badSelector = await rejection("page_wait", { selector: "[" });
		step("page_wait returns when the content arrives and reports a timeout", arrived.ok === true && never.ok === false && badSelector.includes("Invalid CSS selector"), `${arrived.detail} / ${never.detail}`);

		await visit("/inspect-csp");
		const strict = await page("page_snapshot", { selector: "#scope", structure: true });
		const strictInspect = await page("page_inspect", { selector: "#inside" });
		step("page tools work under a strict CSP", strict.structure.tables.length === 1 && strictInspect.elements[0].tag === "button");
	} catch (error) {
		step("page tool scenario", false, String(error));
	} finally {
		if (tabId !== undefined) await ext.tabs.remove(tabId).catch(() => {});
	}
	return steps;
}
