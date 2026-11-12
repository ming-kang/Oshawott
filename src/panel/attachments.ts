import {
	imageDimensions, MAX_ATTACHMENTS, MAX_IMAGE_DIMENSION, MAX_MESSAGE_ATTACHMENT_BYTES, sniffImage, validateAttachment,
	type AttachmentInput,
} from "../lib/attachments.ts";
import { formatBytes } from "../lib/bytes.ts";
import { t } from "./i18n/index.ts";
import { h, icon } from "./ui.ts";

export type PendingAttachment = AttachmentInput & { previewUrl?: string };
type AttachmentError = { id: string; name: string; message: string };

export const pendingInput = (item: PendingAttachment): AttachmentInput => ({
	id: item.id, name: item.name, mimeType: item.mimeType, data: item.data,
});

const ACCEPT = [
	"image/png", "image/jpeg", "image/webp", "image/gif", "text/*", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv",
	".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h",
	".cpp", ".cs", ".swift", ".kt", ".php", ".sh", ".sql", ".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".vue", ".svelte",
].join(",");

async function resizeImage(data: Uint8Array, mimeType: string): Promise<Uint8Array<ArrayBuffer>> {
	const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: mimeType }));
	try {
		const scale = Math.min(1, MAX_IMAGE_DIMENSION / bitmap.width, MAX_IMAGE_DIMENSION / bitmap.height);
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(bitmap.width * scale));
		canvas.height = Math.max(1, Math.round(bitmap.height * scale));
		const context = canvas.getContext("2d");
		if (!context) throw new Error("This browser cannot resize images.");
		context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.92));
		if (!blob) throw new Error("This browser could not re-encode the image.");
		return new Uint8Array(await blob.arrayBuffer());
	} finally {
		bitmap.close();
	}
}

/** Keep all three input paths on exactly the same sniffing, UTF-8 and quota pipeline. */
export class AttachmentPicker {
	readonly tray = h("div", { class: "attachment-tray", id: "attachment-tray", "aria-label": t("attachments.title"), hidden: true });
	readonly input = h("input", { class: "attachment-input", id: "attachment-input", type: "file", multiple: true, accept: ACCEPT, hidden: true });
	readonly button = h("button", {
		class: "icon-btn attachment-add", id: "attach", type: "button", title: t("attachments.add"), "aria-label": t("attachments.add"),
	}, icon("paperclip", 17));
	readonly #onChange: (() => void) | undefined;
	#items: PendingAttachment[] = [];
	#errors: AttachmentError[] = [];
	#generation = 0;

	constructor(onChange?: () => void) {
		this.#onChange = onChange;
		this.button.addEventListener("click", () => this.input.click());
		this.input.addEventListener("change", () => {
			void this.addFiles([...this.input.files ?? []]);
			this.input.value = "";
		});
	}

	get items(): readonly PendingAttachment[] {
		return this.#items;
	}

	get hasImages() {
		return this.#items.some((item) => item.mimeType.startsWith("image/"));
	}

	async addFiles(files: readonly File[]) {
		const generation = this.#generation;
		let changed = false;
		for (const file of files) {
			if (generation !== this.#generation) return;
			if (this.#items.length >= MAX_ATTACHMENTS) {
				this.#errors.push({ id: crypto.randomUUID(), name: file.name, message: t("attachments.tooMany") });
				break;
			}
			try {
				let data = new Uint8Array(await file.arrayBuffer());
				if (generation !== this.#generation) return;
				const image = sniffImage(data);
				if (image && (image === "image/png" || image === "image/jpeg")) {
					const dimensions = imageDimensions(data, image);
					if (dimensions && (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION)) {
						data = await resizeImage(data, image);
						if (generation !== this.#generation) return;
					}
				}
				if (this.#items.length >= MAX_ATTACHMENTS) throw new Error(t("attachments.tooMany"));
				const metadata = validateAttachment({ name: file.name || "clipboard", mimeType: file.type, data });
				const used = this.#items.reduce((sum, item) => sum + item.data.length, 0);
				if (used + data.length > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error(t("attachments.messageQuota"));
				const item: PendingAttachment = {
					id: crypto.randomUUID(), name: metadata.name, mimeType: metadata.mimeType, data,
					...(metadata.mimeType.startsWith("image/") ? { previewUrl: URL.createObjectURL(new Blob([new Uint8Array(data)], { type: metadata.mimeType })) } : {}),
				};
				this.#items.push(item);
				changed = true;
			} catch (error) {
				if (generation !== this.#generation) return;
				this.#errors.push({ id: crypto.randomUUID(), name: file.name || "attachment", message: error instanceof Error ? error.message : String(error) });
			}
		}
		if (generation !== this.#generation) return;
		this.#render();
		if (changed) this.#onChange?.();
	}

	remove(id: string) {
		const item = this.#items.find((item) => item.id === id);
		if (!item) return;
		if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
		this.#items = this.#items.filter((item) => item.id !== id);
		this.#render();
		this.#onChange?.();
	}

	removeSubmitted(ids: readonly string[]) {
		const submitted = new Set(ids);
		for (const item of this.#items) if (submitted.has(item.id) && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
		const before = this.#items.length;
		this.#items = this.#items.filter((item) => !submitted.has(item.id));
		if (this.#items.length !== before) {
			this.#render();
			this.#onChange?.();
		}
	}

	restore(items: readonly AttachmentInput[]) {
		this.#generation++;
		this.#revoke();
		this.#items = items.map((item) => ({
			...item, data: new Uint8Array(item.data),
			...(item.mimeType.startsWith("image/") ? { previewUrl: URL.createObjectURL(new Blob([new Uint8Array(item.data)], { type: item.mimeType })) } : {}),
		}));
		this.#errors = [];
		this.#render();
		this.#onChange?.();
	}

	clear() {
		this.restore([]);
	}

	dispose() {
		this.#generation++;
		this.#revoke();
	}

	#revoke() {
		for (const item of this.#items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
	}

	#render() {
		this.tray.hidden = !this.#items.length && !this.#errors.length;
		const rows: HTMLElement[] = this.#items.map((item) => h("div", { class: "attachment-chip", "data-attachment-id": item.id },
			item.previewUrl
				? h("img", { class: "attachment-preview", src: item.previewUrl, alt: "", width: 36, height: 36 })
				: h("span", { class: "attachment-file-icon" }, icon("file", 17)),
			h("span", { class: "attachment-chip-copy" }, h("span", { class: "attachment-name", title: item.name }, item.name),
				h("span", { class: "attachment-size" }, formatBytes(item.data.length))),
			h("button", {
				class: "icon-btn small attachment-remove", type: "button", title: t("attachments.remove"), "aria-label": `${t("attachments.remove")}: ${item.name}`,
				onclick: () => this.remove(item.id),
			}, icon("x", 13)),
		));
		rows.push(...this.#errors.map((error) => h("div", { class: "attachment-chip attachment-error", role: "alert" },
			icon("alert", 16), h("span", { class: "attachment-chip-copy" }, h("span", { class: "attachment-name" }, error.name), h("span", { class: "attachment-size" }, error.message)),
			h("button", {
				class: "icon-btn small", type: "button", title: t("attachments.dismiss"), "aria-label": t("attachments.dismiss"),
				onclick: () => { this.#errors = this.#errors.filter((item) => item.id !== error.id); this.#render(); },
			}, icon("x", 13)),
		)));
		this.tray.replaceChildren(...rows);
	}
}
