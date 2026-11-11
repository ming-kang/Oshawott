export type AttachmentTestStep = { name: string; ok: boolean; detail?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => T | undefined | null | Promise<T | undefined | null>, ms = 15_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error("attachment control did not settle");
		await sleep(100);
	}
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const bytes = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const chips = () => [...document.querySelectorAll<HTMLElement>("#attachment-tray .attachment-chip:not(.attachment-error)")];

/** Real composer events on both browsers; no privileged test-only attachment API. */
export async function testAttachmentComposer(): Promise<AttachmentTestStep[]> {
	const steps: AttachmentTestStep[] = [];
	const step = (name: string, ok: boolean, detail = "") => steps.push({ name, ok, ...(detail ? { detail } : {}) });
	const prompt = document.querySelector<HTMLTextAreaElement>("#prompt")!;
	try {
		const text = new File(["attachment body\n第二行"], "notes.txt", { type: "text/plain" });
		const transfer = new DataTransfer();
		transfer.items.add(text);
		const input = document.querySelector<HTMLInputElement>("#attachment-input")!;
		input.files = transfer.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await until(() => chips().length === 1 || undefined);

		const imageTransfer = new DataTransfer();
		imageTransfer.items.add(new File([bytes(PNG)], "pixel.png", { type: "image/png" }));
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: imageTransfer });
		prompt.dispatchEvent(paste);
		await until(() => chips().length === 2 || undefined);

		const dropTransfer = new DataTransfer();
		dropTransfer.items.add(new File(["a,b\n1,2"], "table.csv", { type: "text/csv" }));
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(drop, "dataTransfer", { value: dropTransfer });
		document.querySelector("#composer")!.dispatchEvent(drop);
		await until(() => chips().length === 3 || undefined);
		const names = chips().map((chip) => chip.querySelector(".attachment-name")?.textContent);
		step("file picker, clipboard and drop share the attachment pipeline", names.join(",") === "notes.txt,pixel.png,table.csv" && Boolean(document.querySelector("#attachment-tray img")), names.join(", "));

		prompt.value = "Attachment draft";
		prompt.dispatchEvent(new Event("input", { bubbles: true }));
		await sleep(300);
		click("#new-chat");
		await until(() => document.querySelector<HTMLButtonElement>("#files-toggle")?.hidden && !prompt.value && chips().length === 0 || undefined);
		click("#chats-toggle");
		await until(() => document.querySelector(".chat-item .chat-select"));
		click(".chat-item .chat-select");
		await until(() => prompt.value === "Attachment draft" && chips().length === 3 || undefined);
		step("text and pending bytes restore only their own chat", prompt.value === "Attachment draft" && chips().length === 3);

		click("#send");
		const cards = await until(() => {
			const users = [...document.querySelectorAll<HTMLElement>(".msg.user")];
			const found = users.at(-1)?.querySelectorAll(".user-attachment");
			return found?.length === 3 && document.body.dataset.busy === "false" ? [...found] : undefined;
		}, 30_000);
		const lastUser = () => [...document.querySelectorAll<HTMLElement>(".msg.user")].at(-1);
		await until(() => lastUser()?.querySelector(".user-attachment-preview"));
		step("history renders downloadable files and an image without exposing metadata", cards.every((card) => card.getAttribute("data-path")?.startsWith("/workspace/attachments/")) && !lastUser()?.textContent?.includes("oshawott-attachments"));
		step("a successful send clears only submitted composer content", !prompt.value && chips().length === 0);

		let blob: Blob | undefined;
		const original = URL.createObjectURL;
		try {
			URL.createObjectURL = (object) => {
				if (object instanceof Blob) blob = object;
				return original.call(URL, object);
			};
			const note = cards.find((card) => card.getAttribute("data-path")?.endsWith("notes.txt"));
			if (!(note instanceof HTMLElement)) throw new Error("the text attachment card is missing");
			note.click();
			const downloaded = await until(() => blob);
			step("history downloads the same text attachment bytes", await downloaded.text() === "attachment body\n第二行");
		} finally {
			URL.createObjectURL = original;
		}
		click("#files-toggle");
		await until(() => document.querySelector('.file-row[data-path$="notes.txt"]'));
		step("attachments are visible in the existing file lifecycle", Boolean(document.querySelector('.file-row[data-path$="pixel.png"]') && document.querySelector('.file-row[data-path$="table.csv"]')));
		click("#files-back");
	} catch (error) {
		step("attachment browser self-test", false, String(error));
	}
	return steps;
}
