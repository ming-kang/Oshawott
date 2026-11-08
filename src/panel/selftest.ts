import { ext } from "../platform/webext.ts";
import { testAttachmentComposer } from "./attachment-selftest.ts";
import { testToolCards } from "./tool-selftest.ts";

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

export async function selftest(origin: string, panelTests: (origin?: string) => Promise<Step[]>) {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, ...(detail ? { detail } : {}) });
	const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
	const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
	const capture = (ext.tabs as unknown as { captureVisibleTab?(): Promise<string> }).captureVisibleTab;
	const shot = () => capture?.call(ext.tabs).catch(() => undefined);
	const download = async (path: string) => {
		const original = URL.createObjectURL;
		let blob: Blob | undefined;
		try {
			URL.createObjectURL = (object) => {
				if (object instanceof Blob) blob = object;
				return original.call(URL, object);
			};
			click(`.file-row[data-path="${path}"] .file-download`);
			return await until(() => blob);
		} finally {
			URL.createObjectURL = original;
		}
	};
	let filesScreenshot: string | undefined;
	try {
		click("#settings-toggle");
		const providers = await until(() => {
			const ids = all(".provider[data-provider]").map((row) => row.dataset.provider!);
			return ids.length ? ids : undefined;
		});
		click("#settings-back");
		step("panel ↔ Engine over a Port", providers.includes("demo") && !providers.includes("anthropic"), providers.join(", "));

		// The Engine's devtools handle, in the event page (Firefox lets an extension page reach it).
		const background = (await (ext.runtime as unknown as { getBackgroundPage(): Promise<Window> }).getBackgroundPage()) as Window & {
			oshawott: {
				page(tabId: number, tool: string, args: object): Promise<any>;
				codemode(code: string): Promise<{ ok: boolean; value?: unknown; output?: { text?: string }[] }>;
			};
		};
		const target = (await ext.tabs.query({})).find((t) => t.url?.startsWith(origin));
		const chip = await until(() => document.querySelector("#tab-chip .name")?.textContent);
		const page = (tool: string, args: object) => background.oshawott.page(target!.id!, tool, args);
		const snap = await page("page_snapshot", {});
		const input = snap.elements.find((e: { role: string }) => e.role.startsWith("input"));
		const button = snap.elements.find((e: { name: string }) => e.name === "Go");
		step(
			"page_snapshot via Broker injection",
			snap.title === "Oshawott test page" && !!input && !!button,
			`${snap.elements.length} elements; panel targets “${chip}”`,
		);
		await page("page_type", { ref: input.ref, text: "otters" });
		await page("page_click", { ref: button.ref });
		const after = await page("page_snapshot", {});
		step("page_type + page_click act on the page", after.text.includes("searched: otters"), after.text.split("\n").at(-1));

		const run = await background.oshawott.codemode("text('hi from QuickJS'); return [1, 2, 3].map((n) => n * n)");
		step("code mode runs in a Worker", run.ok && JSON.stringify(run.value) === "[1,4,9]", `${JSON.stringify(run.value)} ${run.output?.[0]?.text ?? ""}`);

		const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
		prompt.value = "What is on this page?";
		prompt.dispatchEvent(new Event("input"));
		click("#send");
		const heading = await until(
			() => (document.querySelector(".msg.assistant[data-live]") ? undefined : all(".msg.assistant .md :is(h2, h3)").at(-1)?.textContent),
			30_000,
		);
		const tool = document.querySelector<HTMLElement>('.tool[data-tool="page_snapshot"]');
		step(
			"prompt → page_snapshot on the tab → answer streamed into the panel",
			heading === "Oshawott test page" && tool?.dataset.status === "done",
			`“${heading}”; tool ${tool?.dataset.status}: ${tool?.querySelector(".tool-meta")?.textContent ?? ""}`,
		);

		prompt.value = `Download and measure ${origin}/items.json`;
		prompt.dispatchEvent(new Event("input"));
		click("#send");
		click("#files-toggle");
		await until(() => document.body.dataset.busy === "false" && all('.tool[data-tool="fetch"][data-status="done"], .tool[data-tool="codemode"][data-status="done"]').length === 2, 30_000);
		const paths = await until(() => {
			const rows = all(".file-row");
			return rows.length === 2 ? rows.map((row) => row.dataset.path) : undefined;
		});
		step("fetch → Code Mode file read/write → file sheet refresh", paths.includes("items.json") && paths.includes("items.json.stats.json"), paths.join(", "));

		const file = await download("items.json");
		const downloaded = await file.text();
		step("download through Chat.readFile and an octet-stream Blob", file.type === "application/octet-stream" && JSON.parse(downloaded).items.join(",") === "1,2,3", `${file.size} bytes`);
		filesScreenshot = await shot();

		const first = await storedFile("/workspace/items.json");
		const again = await storedFile("/workspace/items.json");
		const stats = JSON.parse(new TextDecoder().decode(await storedFile("/workspace/items.json.stats.json")));
		step("files are persisted when IndexedDB is reopened", new TextDecoder().decode(first) === downloaded && new TextDecoder().decode(again) === downloaded && stats.characters === downloaded.length, JSON.stringify(stats));
		click('.file-row[data-path="items.json.stats.json"] .file-remove');
		click('.file-row[data-path="items.json.stats.json"] .file-remove');
		await until(() => all(".file-row").length === 1);
		step("file removal refreshes the sheet and deletes the stored bytes", all(".file-row")[0]?.dataset.path === "items.json" && await storedFile("/workspace/items.json.stats.json") === undefined);
		click("#files-back");
		steps.push(...await testAttachmentComposer());
		const reopened = window.open(ext.runtime.getURL("panel.html"), "_blank");
		try {
			await until(() => {
				try {
					return reopened?.document.querySelectorAll(".msg.user .user-attachment").length === 3 || undefined;
				} catch {
					return undefined;
				}
			});
			step("a reopened Firefox Panel restores attachment history", true);
		} catch (error) {
			step("a reopened Firefox Panel restores attachment history", false, String(error));
		} finally {
			reopened?.close();
		}
		steps.push(...await testToolCards(), ...await panelTests(origin));

		const fresh = async (text: string) => {
			click("#new-chat");
			prompt.value = text;
			prompt.dispatchEvent(new Event("input"));
			click("#send");
			await until(() => { const button = document.querySelector<HTMLButtonElement>("#files-toggle"); return button && !button.hidden && !button.disabled; });
		};
		await fresh(`Download ${origin}/large.json`);
		click("#files-toggle");
		await until(() => document.body.dataset.busy === "false" && document.querySelector('.tool[data-tool="codemode"][data-status="done"]') && document.querySelector('.file-row[data-path="large.json.stats.json"]'), 30_000);
		const large = await (await download("large.json")).text();
		const measured = JSON.parse(await (await download("large.json.stats.json")).text());
		step("Code Mode reads a >1M-character single line in chunks, without the preview limit", large.length > 1_000_000 && JSON.parse(large).ending === "complete" && measured.characters === large.length && measured.firstLine.length <= 160, `${measured.characters} characters`);
		click("#files-back");
		for (const [method, path] of [["GET", "redirect-302"], ["POST", "redirect-307"]]) {
			await fresh(`${method === "POST" ? "POST" : "Download"} ${origin}/${path}`);
			const error = await until(() => document.body.dataset.busy === "false" ? document.querySelector('.tool[data-tool="fetch"][data-status="error"] .tool-body')?.textContent : undefined, 20_000);
			click("#files-toggle");
			await until(() => document.querySelector("#files .files-empty"));
			step(`${method} ${path} refused without saving`, error.includes("Redirects are not followed"));
			click("#files-back");
		}
	} catch (error) {
		step("self-test", false, String(error));
	}
	const screenshot = await shot();
	await fetch(`${origin}/report`, { method: "POST", body: JSON.stringify({ steps, screenshot, filesScreenshot }) });
}

/** An independent connection each time: ensure the download really landed in IndexedDB, not just Engine memory. */
async function storedFile(path: string): Promise<Uint8Array | undefined> {
	const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	const db = await request(indexedDB.open("oshawott-files"));
	try {
		const store = db.transaction("data", "readonly").objectStore("data");
		const keys = await request(store.getAllKeys());
		const key = keys.find((key) => Array.isArray(key) && key[1] === path);
		return key === undefined ? undefined : await request(store.get(key)) as Uint8Array;
	} finally {
		db.close();
	}
}
