import { shallowRef } from "vue";
import {
	imageDimensions, MAX_ATTACHMENTS, MAX_IMAGE_DIMENSION, MAX_MESSAGE_ATTACHMENT_BYTES, sniffImage, validateAttachment,
	type AttachmentInput,
} from "../lib/attachments.ts";
import { t } from "./i18n/index.ts";

export type PendingAttachment = AttachmentInput & { previewUrl?: string };
export type AttachmentError = { id: string; name: string; message: string };

export const pendingInput = (item: PendingAttachment): AttachmentInput => ({
	id: item.id, name: item.name, mimeType: item.mimeType, data: item.data,
});

export const ATTACHMENT_ACCEPT = [
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

/** Attachment ingestion is a reactive model; picker, tray and drop target are separate components. */
export class AttachmentPicker {
	readonly #items = shallowRef<readonly PendingAttachment[]>([]);
	readonly #errors = shallowRef<readonly AttachmentError[]>([]);
	readonly #onChange: (() => void) | undefined;
	#generation = 0;

	constructor(onChange?: () => void) {
		this.#onChange = onChange;
	}

	get items() { return this.#items.value; }
	get errors() { return this.#errors.value; }
	get hasImages() { return this.items.some((item) => item.mimeType.startsWith("image/")); }

	async addFiles(files: readonly File[]) {
		const generation = this.#generation;
		let changed = false;
		for (const file of files) {
			if (generation !== this.#generation) return;
			if (this.items.length >= MAX_ATTACHMENTS) {
				this.#errors.value = [...this.errors, { id: crypto.randomUUID(), name: file.name, message: t("attachments.tooMany") }];
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
				if (this.items.length >= MAX_ATTACHMENTS) throw new Error(t("attachments.tooMany"));
				const metadata = validateAttachment({ name: file.name || "clipboard", mimeType: file.type, data });
				const used = this.items.reduce((sum, item) => sum + item.data.length, 0);
				if (used + data.length > MAX_MESSAGE_ATTACHMENT_BYTES) throw new Error(t("attachments.messageQuota"));
				const item: PendingAttachment = {
					id: crypto.randomUUID(), name: metadata.name, mimeType: metadata.mimeType, data,
					...(metadata.mimeType.startsWith("image/") ? { previewUrl: URL.createObjectURL(new Blob([new Uint8Array(data)], { type: metadata.mimeType })) } : {}),
				};
				this.#items.value = [...this.items, item];
				changed = true;
			} catch (error) {
				if (generation !== this.#generation) return;
				this.#errors.value = [...this.errors, {
					id: crypto.randomUUID(), name: file.name || "attachment", message: error instanceof Error ? error.message : String(error),
				}];
			}
		}
		if (generation === this.#generation && changed) this.#onChange?.();
	}

	remove(id: string) {
		const item = this.items.find((item) => item.id === id);
		if (!item) return;
		if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
		this.#items.value = this.items.filter((item) => item.id !== id);
		this.#onChange?.();
	}

	removeSubmitted(ids: readonly string[]) {
		const submitted = new Set(ids);
		for (const item of this.items) if (submitted.has(item.id) && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
		const items = this.items.filter((item) => !submitted.has(item.id));
		if (items.length === this.items.length) return;
		this.#items.value = items;
		this.#onChange?.();
	}

	restore(items: readonly AttachmentInput[]) {
		this.#generation++;
		this.#revoke();
		this.#items.value = items.map((item) => ({
			...item, data: new Uint8Array(item.data),
			...(item.mimeType.startsWith("image/") ? { previewUrl: URL.createObjectURL(new Blob([new Uint8Array(item.data)], { type: item.mimeType })) } : {}),
		}));
		this.#errors.value = [];
		this.#onChange?.();
	}

	dismissError(id: string) {
		this.#errors.value = this.errors.filter((error) => error.id !== id);
	}

	clear() { this.restore([]); }

	dispose() {
		this.#generation++;
		this.#revoke();
	}

	#revoke() {
		for (const item of this.items) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
	}
}
