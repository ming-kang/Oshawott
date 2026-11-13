import type { Chat } from "../contracts/chat.ts";
import { formatBytes } from "../lib/bytes.ts";
import { BACKGROUND_CONTEXT, type Reference } from "../lib/chord.ts";
import { LANG, t } from "./i18n/index.ts";
import type { OverlayView } from "./overlays.ts";
import { confirmControl, type ConfirmControl, download, errorMessage, h, icon, toast, toastError } from "./ui.ts";

type FileSource = Pick<Extract<Reference<typeof Chat>, { variant: "owner" }>, "files" | "readFile" | "removeFile">;
type FileInfo = Awaited<ReturnType<FileSource["files"]>>[number];
const context = BACKGROUND_CONTEXT;
const dateFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export class FilesSheet implements OverlayView {
	readonly element: HTMLElement;
	readonly #source: FileSource;
	readonly #list = h("div", { class: "card file-list", id: "file-list", role: "list" });
	readonly #summary = h("div", { class: "files-summary", role: "status" });
	readonly #refresh = h("button", { class: "icon-btn", id: "files-refresh", type: "button", title: t("files.refresh"), "aria-label": t("files.refresh") }, icon("refresh", 18));
	readonly #confirms = new Set<ConfirmControl>();
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
			),
		);
	}

	close() {
		this.#closed = true;
		this.#revision++;
		this.#clearConfirms();
	}

	#clearConfirms() {
		for (const confirm of this.#confirms) confirm.reset();
		this.#confirms.clear();
	}

	async refresh() {
		if (this.#closed) return;
		const revision = ++this.#revision;
		const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		const focusedRow = active?.closest<HTMLElement>(".file-row");
		const focused = focusedRow ? {
			path: focusedRow.dataset.path,
			index: [...this.#list.querySelectorAll(".file-row")].indexOf(focusedRow),
			action: active?.classList.contains("file-remove") ? ".file-remove" : ".file-download",
		} : undefined;
		this.#refresh.disabled = true;
		this.#list.setAttribute("aria-busy", "true");
		this.#summary.textContent = t("files.loading");
		try {
			const files = await this.#source.files(context);
			if (this.#closed || revision !== this.#revision) return;
			this.#summary.textContent = t("files.count", files.length, formatBytes(files.reduce((sum, file) => sum + file.size, 0)));
			this.#clearConfirms();
			this.#list.replaceChildren(
				...(files.length ? files.map((file) => this.#row(file)) : [h("div", { class: "files-empty", role: "status" }, icon("folder", 30), h("strong", null, t("files.empty")))]),
			);
		} catch (error) {
			if (this.#closed || revision !== this.#revision) return;
			this.#summary.textContent = "";
			this.#list.replaceChildren(h("div", { class: "files-error", role: "alert" }, icon("alert", 18), h("span", null, errorMessage(error))));
		} finally {
			if (!this.#closed && revision === this.#revision) {
				this.#refresh.disabled = false;
				this.#list.setAttribute("aria-busy", "false");
				if (focused) {
					const rows = [...this.#list.querySelectorAll<HTMLElement>(".file-row")];
					const same = rows.find((row) => row.dataset.path === focused.path);
					const row = same ?? rows[Math.min(Math.max(focused.index, 0), rows.length - 1)];
					const target = row?.querySelector<HTMLElement>(same ? focused.action : ".file-download") ?? this.#refresh;
					target.focus({ preventScroll: true });
				}
			}
		}
	}

	#row(file: FileInfo) {
		const save = h("button", { class: "icon-btn small file-download", type: "button", title: t("files.download"), "aria-label": `${t("files.download")}: ${file.path}` }, icon("download", 16));
		save.addEventListener("click", async () => {
			save.disabled = true;
			try {
				const bytes = await this.#source.readFile({ path: file.path }, context);
				if (this.#closed) return;
				download(bytes, file.path.split("/").at(-1) || "download");
				toast(t("files.downloadStarted"));
			} catch (error) {
				if (!this.#closed) toastError(error);
			} finally {
				save.disabled = false;
			}
		});

		const remove = h("button", { class: "icon-btn small file-remove", type: "button", title: t("files.remove"), "aria-label": `${t("files.remove")}: ${file.path}` }, icon("trash", 15));
		const confirm = confirmControl(remove, { confirm: () => t("files.confirm"), idle: () => [icon("trash", 15)] });
		this.#confirms.add(confirm);
		remove.addEventListener("click", async () => {
			if (!confirm.armed) return confirm.arm();
			remove.disabled = true;
			try {
				await this.#source.removeFile({ path: file.path }, context);
				if (this.#closed) return;
				toast(t("files.removed", file.path));
				await this.refresh();
			} catch (error) {
				if (!this.#closed) toastError(error);
			} finally {
				remove.disabled = false;
				confirm.reset();
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
			h("div", { class: "file-actions" }, save, remove),
		);
	}
}
