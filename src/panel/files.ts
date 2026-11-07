// A chat's files in a sheet: list, download, remove. It holds the chat reference supplied by the panel, not a copy
// of its files. Refreshes are explicit (opening, refresh button, a run ending); stale reads cannot overwrite a newer
// list or a closed sheet. Downloaded bytes become an octet-stream Blob, never HTML rendered in the extension.
import type { Chat } from "../contracts/chat.ts";
import { formatBytes } from "../lib/bytes.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { LANG, t } from "./i18n.ts";
import type { OverlayView } from "./overlays.ts";
import { h, icon, toast } from "./ui.ts";

type FileSource = Pick<Extract<Reference<typeof Chat>, { variant: "owner" }>, "files" | "readFile" | "removeFile">;
type FileInfo = Awaited<ReturnType<FileSource["files"]>>[number];
const context = BACKGROUND_CONTEXT;
const dateFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const errorText = (error: unknown) => String((error as Error)?.message ?? error);

export class FilesSheet implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: FileSource;
	readonly #list = h("div", { class: "card file-list", id: "file-list", role: "list" });
	readonly #summary = h("div", { class: "files-summary", role: "status" });
	readonly #refresh = h("button", { class: "icon-btn", id: "files-refresh", type: "button", title: t("files.refresh"), "aria-label": t("files.refresh") }, icon("refresh", 18));
	#revision = 0;
	#closed = false;

	constructor(source: FileSource, onClose: () => void) {
		this.#source = source;
		this.#refresh.addEventListener("click", () => void this.refresh());
		this.element = h(
			"section",
			{ class: "sheet", id: "files", role: "dialog", "aria-modal": "true", "aria-label": t("files.title") },
			h(
				"div",
				{ class: "panel-head" },
				h("button", { class: "icon-btn", id: "files-back", type: "button", "aria-label": t("files.back"), onclick: onClose }, icon("back", 18)),
				h("span", { class: "panel-title" }, t("files.title")),
				this.#refresh,
			),
			h(
				"div",
				{ class: "sheet-body files-body" },
				h("div", { class: "files-location" }, icon("folder", 18), h("code", null, "/workspace"), this.#summary),
				this.#list,
				h("p", { class: "section-hint" }, icon("lock", 12), h("span", null, t("files.hint"))),
			),
		);
	}

	close() {
		this.#closed = true;
		this.#revision++;
	}

	async refresh() {
		if (this.#closed) return;
		const revision = ++this.#revision;
		this.#refresh.disabled = true;
		this.#list.setAttribute("aria-busy", "true");
		this.#summary.textContent = t("files.loading");
		try {
			const files = await this.#source.files(context);
			if (this.#closed || revision !== this.#revision) return;
			this.#summary.textContent = t("files.count", files.length, formatBytes(files.reduce((sum, file) => sum + file.size, 0)));
			this.#list.replaceChildren(
				...(files.length ? files.map((file) => this.#row(file)) : [h("div", { class: "files-empty" }, icon("folder", 30), h("strong", null, t("files.empty")), h("span", null, t("files.emptyHint")))]),
			);
		} catch (error) {
			if (this.#closed || revision !== this.#revision) return;
			this.#summary.textContent = "";
			this.#list.replaceChildren(h("div", { class: "files-error", role: "alert" }, icon("alert", 18), h("span", null, errorText(error))));
		} finally {
			if (!this.#closed && revision === this.#revision) {
				this.#refresh.disabled = false;
				this.#list.setAttribute("aria-busy", "false");
			}
		}
	}

	#row(file: FileInfo) {
		const download = h("button", { class: "icon-btn small file-download", type: "button", title: t("files.download"), "aria-label": `${t("files.download")}: ${file.path}` }, icon("download", 16));
		download.addEventListener("click", async () => {
			download.disabled = true;
			try {
				const bytes = await this.#source.readFile({ path: file.path }, context);
				if (this.#closed) return;
				const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
				const link = h("a", { href: url, download: file.path.split("/").at(-1) || "download", hidden: true });
				document.body.append(link);
				link.click();
				link.remove();
				// Firefox may begin its download after the click returns. Keep the URL briefly, then release its bytes.
				setTimeout(() => URL.revokeObjectURL(url), 30_000);
				toast(t("files.downloadStarted"));
			} catch (error) {
				if (!this.#closed) toast(errorText(error), "error");
			} finally {
				download.disabled = false;
			}
		});

		const remove = h("button", { class: "icon-btn small file-remove", type: "button", title: t("files.remove"), "aria-label": `${t("files.remove")}: ${file.path}` }, icon("trash", 15));
		remove.addEventListener("click", async () => {
			if (remove.dataset.confirm === undefined) {
				remove.dataset.confirm = "";
				remove.replaceChildren(t("files.confirm"));
				setTimeout(() => {
					if (!remove.isConnected || remove.disabled) return;
					delete remove.dataset.confirm;
					remove.replaceChildren(icon("trash", 15));
				}, 3000);
				return;
			}
			remove.disabled = true;
			try {
				await this.#source.removeFile({ path: file.path }, context);
				if (this.#closed) return;
				toast(t("files.removed", file.path));
				await this.refresh();
			} catch (error) {
				if (!this.#closed) toast(errorText(error), "error");
			} finally {
				remove.disabled = false;
				delete remove.dataset.confirm;
				remove.replaceChildren(icon("trash", 15));
			}
		});
		return h(
			"div",
			{ class: "file-row", role: "listitem", "data-path": file.path },
			h("span", { class: "file-icon" }, icon("file", 20)),
			h(
				"div",
				{ class: "file-info" },
				h("span", { class: "file-path", title: file.path }, file.path),
				h("div", { class: "file-meta" }, h("span", null, formatBytes(file.size)), h("time", { datetime: new Date(file.mtimeMs).toISOString() }, dateFormat.format(file.mtimeMs))),
			),
			h("div", { class: "file-actions" }, download, remove),
		);
	}
}
