import { computed, defineComponent, onBeforeUnmount, onMounted, shallowRef, watch, type PropType } from "vue";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import { formatBytes } from "../lib/bytes.ts";
import { Icon, NativeView, useConfirmation } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { previewKind } from "./file-preview.ts";
import type { ChatRef } from "./session.ts";
import { LANG, t } from "./i18n/index.ts";
import { codeBlock } from "./tool-highlight.ts";
import { download, errorMessage, toast, toastError } from "./ui.ts";

const context = BACKGROUND_CONTEXT;
const dateFormat = new Intl.DateTimeFormat(LANG, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
type FileInfo = Awaited<ReturnType<ChatRef["files"]>>[number];
const MAX_PREVIEW_BYTES = 256 * 1024;

type PreviewState =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "text"; text: string; language?: string; truncated: boolean }
	| { status: "image"; url: string }
	| { status: "binary" };

const FilePreview = defineComponent({
	props: {
		source: { type: Object as PropType<ChatRef>, required: true }, file: { type: Object as PropType<FileInfo>, required: true },
		onDownload: { type: Function as PropType<() => void>, required: true },
	},
	setup(props) {
		const state = shallowRef<PreviewState>({ status: "loading" });
		let objectUrl: string | undefined;
		const block = computed(() => state.value.status === "text" ? codeBlock(state.value.text, state.value.language) : undefined);
		onMounted(() => void (async () => {
			try {
				const bytes = await props.source.readFile({ path: props.file.path }, context);
				const kind = previewKind(props.file.path, bytes);
				if (kind.type === "image") {
					objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: kind.mime }));
					state.value = { status: "image", url: objectUrl };
				} else if (kind.type === "text") {
					const truncated = bytes.length > MAX_PREVIEW_BYTES;
					const text = new TextDecoder().decode(truncated ? bytes.subarray(0, MAX_PREVIEW_BYTES) : bytes);
					const language = kind.language;
					try {
						const parsed = JSON.stringify(JSON.parse(text), null, 2);
						state.value = { status: "text", text: parsed, language: "json", truncated };
					} catch {
						state.value = { status: "text", text, language, truncated };
					}
				} else {
					state.value = { status: "binary" };
				}
			} catch (error) {
				state.value = { status: "error", message: errorMessage(error) };
			}
		})());
		onBeforeUnmount(() => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
		return () => (
			<div class="file-preview" data-status={state.value.status}>
				{state.value.status === "loading" && <div class="file-preview-state"><span class="spinner" /></div>}
				{state.value.status === "error" && <div class="file-preview-state error" role="alert"><Icon name="alert" size={14} /><span>{state.value.message}</span></div>}
				{state.value.status === "image" && <img class="file-preview-image" src={state.value.url} alt={props.file.path} />}
				{state.value.status === "text" && <>
					<NativeView element={block.value!} />
					{state.value.truncated && <div class="file-preview-note">{t("files.truncated")}</div>}
				</>}
				{state.value.status === "binary" && (
					<div class="file-preview-state">
						<Icon name="file" size={14} /><span class="file-preview-note-text">{t("files.noPreview")}</span>
						<button class="btn small file-preview-download" type="button" onClick={() => props.onDownload()}><Icon name="download" size={13} />{t("files.download")}</button>
					</div>
				)}
			</div>
		);
	},
});

const FileRow = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		source: { type: Object as PropType<ChatRef>, required: true }, file: { type: Object as PropType<FileInfo>, required: true },
		refresh: { type: Function as PropType<() => Promise<void>>, required: true },
		expanded: Boolean,
		onToggle: { type: Function as PropType<() => void>, required: true },
	},
	setup(props) {
		const downloading = shallowRef(false);
		const removing = shallowRef(false);
		const confirmation = useConfirmation();
		const save = async () => {
			if (downloading.value) return;
			downloading.value = true;
			try {
				const bytes = await props.source.readFile({ path: props.file.path }, context);
				download(bytes, props.file.path.split("/").at(-1) || "download");
				toast(t("files.downloadStarted"));
			} catch (error) { toastError(error); } finally { downloading.value = false; }
		};
		const insert = () => {
			props.controller.overlays.close(false);
			props.controller.composer.insertText(`/workspace/${props.file.path}`);
		};
		const remove = async () => {
			if (removing.value) return;
			if (!confirmation.armed.value) return confirmation.arm();
			removing.value = true;
			confirmation.reset();
			try {
				await props.source.removeFile({ path: props.file.path }, context);
				toast(t("files.removed", props.file.path));
				await props.refresh();
			} catch (error) { toastError(error); } finally { removing.value = false; }
		};
		return () => (
			<div class="file-row" role="listitem" data-path={props.file.path}>
				<div class="file-line">
					<span class="file-icon"><Icon name="file" size={20} /></span>
					<button class="file-info" type="button" title={t("files.preview")} aria-label={`${t("files.preview")}: ${props.file.path}`}
						aria-expanded={props.expanded} onClick={() => props.onToggle()}>
						<span class="file-path" title={props.file.path}>{props.file.path}</span>
						<span class="file-meta"><span>{formatBytes(props.file.size)}</span><time datetime={new Date(props.file.mtimeMs).toISOString()}>{dateFormat.format(props.file.mtimeMs)}</time></span>
					</button>
					<div class="file-actions">
						<button class="icon-btn small file-insert" type="button" title={t("files.insert")} aria-label={`${t("files.insert")}: ${props.file.path}`}
							disabled={downloading.value || removing.value} onClick={insert}><Icon name="insert" size={15} /></button>
						<button class="icon-btn small file-download" type="button" title={t("files.download")} aria-label={`${t("files.download")}: ${props.file.path}`}
							disabled={downloading.value || removing.value} onClick={() => void save()}><Icon name="download" size={16} /></button>
						<button class="icon-btn small file-remove" type="button" title={confirmation.armed.value ? t("files.confirm") : t("files.remove")}
							aria-label={`${confirmation.armed.value ? t("files.confirm") : t("files.remove")}: ${props.file.path}`}
							data-confirm={confirmation.armed.value ? "" : undefined} disabled={downloading.value || removing.value} onClick={() => void remove()}>
							{confirmation.armed.value ? t("files.confirm") : <Icon name="trash" size={15} />}
						</button>
					</div>
				</div>
				{props.expanded && <FilePreview source={props.source} file={props.file} onDownload={() => void save()} />}
			</div>
		);
	},
});

export const FilesSheet = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const source = props.controller.session.chat;
		if (!source) throw new Error("The chat is not open.");
		const files = shallowRef<readonly FileInfo[]>([]);
		const loading = shallowRef(true);
		const error = shallowRef("");
		const previewPath = shallowRef<string>();
		let revision = 0;
		let disposed = false;
		const refresh = async () => {
			const ticket = ++revision;
			loading.value = true;
			error.value = "";
			try {
				const result = await source.files(context);
				if (!disposed && ticket === revision) files.value = result;
			} catch (reason) {
				if (!disposed && ticket === revision) error.value = errorMessage(reason);
			} finally {
				if (!disposed && ticket === revision) loading.value = false;
			}
		};
		onMounted(() => void refresh());
		onBeforeUnmount(() => { disposed = true; revision++; });
		watch(props.controller.store.busy, (busy, wasBusy) => { if (wasBusy && !busy) void refresh(); });
		return () => (
			<section class="sheet" id="files" role="dialog" aria-modal="true" aria-label={t("files.title")}>
				<div class="panel-head">
					<button class="icon-btn" id="files-back" type="button" title={t("files.back")} aria-label={t("files.back")} onClick={() => props.controller.overlays.close()}><Icon name="back" size={18} /></button>
					<span class="panel-title">{t("files.title")}</span>
					<button class="icon-btn" id="files-refresh" type="button" title={t("files.refresh")} aria-label={t("files.refresh")}
						disabled={loading.value} onClick={() => void refresh()}><Icon name="refresh" size={18} /></button>
				</div>
				<div class="sheet-body files-body">
					<div class="files-location"><Icon name="folder" size={18} /><code>/workspace</code>
						<div class="files-summary" role="status">{loading.value ? t("files.loading") : error.value ? "" : t("files.count", files.value.length, formatBytes(files.value.reduce((sum, file) => sum + file.size, 0)))}</div></div>
					<div class="card file-list" id="file-list" role="list" aria-busy={loading.value}>
						{error.value ? <div class="files-error" role="alert"><Icon name="alert" size={18} /><span>{error.value}</span></div>
							: files.value.length ? files.value.map((file) => (
								<FileRow controller={props.controller} source={source} file={file} refresh={refresh} key={file.path}
									expanded={previewPath.value === file.path}
									onToggle={() => { previewPath.value = previewPath.value === file.path ? undefined : file.path; }} />
							))
								: !loading.value && <div class="files-empty" role="status"><Icon name="folder" size={30} /><strong>{t("files.empty")}</strong></div>}
					</div>
				</div>
			</section>
		);
	},
});
