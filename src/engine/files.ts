// Each chat's files: a small tree of files and directories per conversation, behind pi-durable's `ExecutionEnv`, so
// its `read`, `write` and `edit` tools, code mode's output files, and Oshawatt's `ls` and `fetch` work on it as on a
// disk. A `FileBackend` keeps the trees: IndexedDB in the browser (`files-idb.ts`), a Map in tests. The files outlive
// the Engine's document, so a restarted Engine finds them, and go with their chat.
//
// Paths are POSIX and absolute from the chat's own root; the working directory is `/workspace`. There are no symbolic
// links, no change notifications, and no shell: `exec` fails with `shell_unavailable`, and the model processes files
// with code mode instead.
import type { Context } from "@earendil-works/chord/context";
import {
	type BinaryReader,
	type DirReader,
	err,
	ExecutionError,
	type ExecutionEnv,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileListEntry,
	type FileListing,
	type FileWatcher,
	LineScanner,
	type ListFilesOptions,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	StreamDecoder,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";

import { MAX_FILE_BYTES } from "../contracts/chat.ts";

export { MAX_FILE_BYTES };
export const WORKSPACE = "/workspace";

export type Entry = { readonly kind: "file" | "directory"; readonly size: number; readonly mtimeMs: number };

/** One transaction on one chat's tree. Reads are awaited; writes apply in order and land with the transaction. */
export interface FileTx {
	get(path: string): Promise<Entry | undefined>;
	data(path: string): Promise<Uint8Array | undefined>;
	/** Every entry strictly below the directory `dir`, in no particular order. */
	below(dir: string): Promise<(readonly [string, Entry])[]>;
	/** A file's entry with its bytes, or a directory's. */
	put(path: string, entry: Entry, data?: Uint8Array): void;
	delete(path: string): void;
}

export interface FileBackend {
	/**
	 * Runs `fn` in one transaction on `chat`'s tree: all of its writes land, or none. `fn` awaits nothing but the
	 * transaction's own reads (an IndexedDB transaction ends at the first await of anything else).
	 */
	transact<T>(chat: number, mode: "readonly" | "readwrite", fn: (tx: FileTx) => Promise<T>): Promise<T>;
	/** Removes `chat`'s whole tree. */
	clear(chat: number): Promise<void>;
	/** Releases the storage connection after the Engine has stopped its work. */
	close?(): void;
}

/** A `FileBackend` in memory, for tests: one transaction at a time, writes staged until it resolves. */
export class MemoryFileBackend implements FileBackend {
	readonly #trees = new Map<number, Map<string, { entry: Entry; data?: Uint8Array }>>();
	#tail: Promise<unknown> = Promise.resolve();

	transact<T>(chat: number, _mode: "readonly" | "readwrite", fn: (tx: FileTx) => Promise<T>): Promise<T> {
		const run = async () => {
			const staged = new Map(this.#trees.get(chat));
			const result = await fn({
				get: async (path) => staged.get(path)?.entry,
				data: async (path) => staged.get(path)?.data?.slice(),
				below: async (dir) => {
					const prefix = dir === "/" ? "/" : `${dir}/`;
					return [...staged].filter(([path]) => path.startsWith(prefix)).map(([path, { entry }]) => [path, entry] as const);
				},
				put: (path, entry, data) => void staged.set(path, { entry, ...(data ? { data: data.slice() } : {}) }),
				delete: (path) => void staged.delete(path),
			});
			this.#trees.set(chat, staged);
			return result;
		};
		const result = this.#tail.then(run);
		this.#tail = result.catch(() => undefined);
		return result;
	}

	clear(chat: number): Promise<void> {
		const result = this.#tail.then(() => { this.#trees.delete(chat); });
		this.#tail = result.catch(() => undefined);
		return result;
	}
}

// ── Paths ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `path` as an absolute, normalized path: relative to `cwd`, without `.`, `..`, or empty segments. */
export function resolvePath(cwd: string, path: string): string {
	const parts: string[] = [];
	for (const part of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return `/${parts.join("/")}`;
}

export const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const prefixOf = (dir: string) => (dir === "/" ? "/" : `${dir}/`);
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const encoder = new TextEncoder();
const bytesOf = (content: string | Uint8Array) => (typeof content === "string" ? encoder.encode(content) : content);

function fail<T>(code: FileErrorCode, message: string, path?: string): Result<T, FileError> {
	return err(new FileError(code, message, path));
}

const notFound = <T>(path: string) => fail<T>("not_found", `No such file or directory: ${path}`, path);
const tooLarge = <T>(path: string, size: number) =>
	fail<T>("invalid", `File too large: ${size} bytes (at most ${MAX_FILE_BYTES})`, path);
const aborted = <T>(context: Context, path?: string) =>
	context.abortSignal?.aborted ? fail<T>("aborted", "Operation aborted", path) : undefined;
const isCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

const DIRECTORY: Entry = { kind: "directory", size: 0, mtimeMs: 0 };

/** A file of a chat as the panel lists it: its path below `/workspace`. */
export type WorkspaceFile = { readonly path: string; readonly size: number; readonly mtimeMs: number };

// ── The environment ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One chat's files as an `ExecutionEnv`. Cheap to make: it holds no state of its own. */
export class ChatFiles implements ExecutionEnv {
	readonly id: string;
	cwd = WORKSPACE;
	readonly #backend: FileBackend;
	readonly #chat: number;
	readonly #now: () => number;
	readonly #requireActive: ((context: Context) => Promise<void>) | undefined;

	constructor(backend: FileBackend, chat: number, now: () => number = Date.now, requireActive?: (context: Context) => Promise<void>) {
		this.id = `oshawatt-files:${chat}`;
		this.#backend = backend;
		this.#chat = chat;
		this.#now = now;
		this.#requireActive = requireActive;
	}

	#resolve(path: string) {
		return resolvePath(this.cwd, path);
	}

	/** The root and the working directory always exist and cannot be removed or moved. */
	#fixed(path: string) {
		return path === "/" || path === WORKSPACE;
	}

	async #get(tx: FileTx, path: string): Promise<Entry | undefined> {
		return (await tx.get(path)) ?? (this.#fixed(path) ? DIRECTORY : undefined);
	}

	async #run<T>(
		mode: "readonly" | "readwrite",
		context: Context,
		path: string | undefined,
		fn: (tx: FileTx) => Promise<Result<T, FileError>>,
	): Promise<Result<T, FileError>> {
		const stop = aborted<T>(context, path);
		if (stop) return stop;
		try {
			// The active-chat check is outside the IndexedDB transaction: no unrelated await may occur inside it.
			if (this.#requireActive) await this.#requireActive(context);
			const cancelled = aborted<T>(context, path);
			if (cancelled) return cancelled;
			return await this.#backend.transact(this.#chat, mode, fn);
		} catch (error) {
			return error instanceof FileError ? err(error) : fail("unknown", error instanceof Error ? error.message : String(error), path);
		}
	}

	#info(path: string, entry: Entry): FileInfo {
		return { name: nameOf(path), path, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs };
	}

	async #file(tx: FileTx, path: string): Promise<Result<{ entry: Entry; data: Uint8Array }, FileError>> {
		const entry = await this.#get(tx, path);
		if (!entry) return notFound(path);
		if (entry.kind === "directory") return fail("is_directory", `Is a directory: ${path}`, path);
		return ok({ entry, data: (await tx.data(path)) ?? new Uint8Array() });
	}

	/** Checks that `path`'s parents are directories or missing; the missing ones, to create, else the failure. */
	async #missingParents(tx: FileTx, path: string): Promise<Result<string[], FileError>> {
		const missing: string[] = [];
		for (let dir = parentOf(path); ; dir = parentOf(dir)) {
			const entry = await this.#get(tx, dir);
			if (entry?.kind === "directory") return ok(missing);
			if (entry) return fail("not_directory", `Not a directory: ${dir}`, dir);
			missing.push(dir);
		}
	}

	#createDirs(tx: FileTx, dirs: readonly string[]) {
		for (const dir of [...dirs].reverse()) tx.put(dir, { kind: "directory", size: 0, mtimeMs: this.#now() });
	}

	/** Writes a whole file, creating its parents. */
	async #put(tx: FileTx, path: string, data: Uint8Array): Promise<Result<void, FileError>> {
		if (data.length > MAX_FILE_BYTES) return tooLarge(path, data.length);
		if ((await this.#get(tx, path))?.kind === "directory") return fail("is_directory", `Is a directory: ${path}`, path);
		const parents = await this.#missingParents(tx, path);
		if (!parents.ok) return parents;
		this.#createDirs(tx, parents.value);
		tx.put(path, { kind: "file", size: data.length, mtimeMs: this.#now() }, data);
		return ok(undefined);
	}

	async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return ok(this.#resolve(path));
	}

	async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
		const joined = parts.filter(Boolean).join("/");
		const absolute = joined.startsWith("/");
		const normalized: string[] = [];
		for (const part of joined.split("/")) {
			if (!part || part === ".") continue;
			if (part !== "..") normalized.push(part);
			else if (normalized.length && normalized.at(-1) !== "..") normalized.pop();
			else if (!absolute) normalized.push("..");
		}
		return ok(`${absolute ? "/" : ""}${normalized.join("/")}` || ".");
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const target = this.#resolve(path);
		return this.#run("readonly", context, target, async (tx) => {
			const file = await this.#file(tx, target);
			return file.ok ? ok(file.value.data) : err(file.error);
		});
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const read = await this.readBinaryFile(path, context);
		// As Node's `readFile(path, "utf8")`: a byte-order mark stays.
		return read.ok ? ok(new TextDecoder("utf-8", { ignoreBOM: true }).decode(read.value)) : err(read.error);
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const read = await this.readBinaryFile(path, context);
		if (!read.ok) return err(read.error);
		const decoder = new StreamDecoder();
		const lines = (decoder.decode(read.value) + decoder.decode()).split("\n");
		const terminated = lines.length - 1;
		if (lines.at(-1) === "") lines.pop();
		let next = 0;
		let closed = false;
		const target = this.#resolve(path);
		return ok({
			readLine: async (ctx) => {
				const stop = aborted<undefined>(ctx, target);
				if (stop) return stop;
				if (closed) return fail("invalid", "Text line reader is closed", target);
				if (next >= lines.length) return ok(undefined);
				const index = next++;
				return ok({ text: lines[index]!, terminated: index < terminated });
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		const text = await this.readBinaryFile(path, context);
		if (!text.ok) return err(text.error);
		const decoder = new StreamDecoder();
		const lines = (decoder.decode(text.value) + decoder.decode()).split("\n");
		if (lines.at(-1) === "") lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	async openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const target = this.#resolve(path);
		// The reader keeps the bytes it opened: a later rename or write does not change what it reads.
		const opened = await this.#run("readonly", context, target, (tx) => this.#file(tx, target));
		if (!opened.ok) return err(opened.error);
		const { entry, data } = opened.value;
		const info = this.#info(target, entry);
		let closed = false;
		const usable = <T>(ctx: Context) => (closed ? fail<T>("invalid", "Binary reader is closed", target) : aborted<T>(ctx, target));
		return ok({
			info: async (ctx) => usable<FileInfo>(ctx) ?? ok({ ...info }),
			read: async (offset, length, ctx) => {
				const stop = usable<Uint8Array>(ctx);
				if (stop) return stop;
				if (!isCount(offset) || !isCount(length)) return fail("invalid", "Offset and length must be non-negative integers", target);
				return ok(data.slice(offset, offset + length));
			},
			scanLines: async ({ startLine, endLine }, ctx) => {
				const stop = usable<ReturnType<LineScanner["finish"]>>(ctx);
				if (stop) return stop;
				try {
					const scanner = new LineScanner(startLine, endLine);
					scanner.push(data);
					return ok(scanner.finish());
				} catch (error) {
					return fail("invalid", error instanceof Error ? error.message : String(error), target);
				}
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const target = this.#resolve(path);
		const data = bytesOf(content);
		return this.#run("readwrite", context, target, (tx) => this.#put(tx, target, data));
	}

	async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const target = this.#resolve(path);
		const tail = bytesOf(content);
		return this.#run("readwrite", context, target, async (tx) => {
			const entry = await this.#get(tx, target);
			if (!entry) return this.#put(tx, target, tail);
			const file = await this.#file(tx, target);
			if (!file.ok) return err(file.error);
			const size = file.value.data.length + tail.length;
			if (size > MAX_FILE_BYTES) return tooLarge(target, size);
			const data = new Uint8Array(size);
			data.set(file.value.data);
			data.set(tail, file.value.data.length);
			return this.#put(tx, target, data);
		});
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const target = this.#resolve(path);
		if (!isCount(size)) return fail("invalid", "File size must be a non-negative safe integer", target);
		if (size > MAX_FILE_BYTES) return tooLarge(target, size);
		return this.#run("readwrite", context, target, async (tx) => {
			const file = await this.#file(tx, target);
			if (!file.ok) return err(file.error);
			const data = new Uint8Array(size);
			data.set(file.value.data.subarray(0, size));
			return this.#put(tx, target, data);
		});
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const target = this.#resolve(path);
		return this.#run("readonly", context, target, async (tx) => {
			const file = await this.#file(tx, target);
			return file.ok ? ok(undefined) : err(file.error);
		});
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = this.#resolve(sourcePath);
		const destination = this.#resolve(destinationPath);
		return this.#run("readwrite", context, source, async (tx) => {
			const from = await this.#get(tx, source);
			if (!from) return notFound(source);
			if (source === destination) return ok(undefined);
			if (this.#fixed(source) || this.#fixed(destination)) return fail("permission_denied", `Cannot move ${source} to ${destination}`, source);
			if (destination.startsWith(prefixOf(source))) return fail("invalid", `Cannot move ${source} into itself`, destination);
			const parent = await this.#get(tx, parentOf(destination));
			if (!parent) return notFound(parentOf(destination));
			if (parent.kind !== "directory") return fail("not_directory", `Not a directory: ${parentOf(destination)}`, destination);
			const to = await this.#get(tx, destination);
			if (to?.kind === "directory" && from.kind === "file") return fail("is_directory", `Is a directory: ${destination}`, destination);
			if (to?.kind === "file" && from.kind === "directory") return fail("not_directory", `Not a directory: ${destination}`, destination);
			if (to?.kind === "directory" && (await tx.below(destination)).length > 0) {
				return fail("invalid", `Directory not empty: ${destination}`, destination);
			}
			const moving = from.kind === "directory" ? await tx.below(source) : [];
			const moved: [string, Entry, Uint8Array | undefined][] = [[destination, from, from.kind === "file" ? await tx.data(source) : undefined]];
			for (const [path, entry] of moving) {
				moved.push([destination + path.slice(source.length), entry, entry.kind === "file" ? await tx.data(path) : undefined]);
			}
			tx.delete(source);
			for (const [path] of moving) tx.delete(path);
			for (const [path, entry, data] of moved) tx.put(path, entry, entry.kind === "file" ? (data ?? new Uint8Array()) : undefined);
			return ok(undefined);
		});
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const target = this.#resolve(path);
		return this.#run("readonly", context, target, async (tx) => {
			const entry = await this.#get(tx, target);
			return entry ? ok(this.#info(target, entry)) : notFound(target);
		});
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const info = await this.fileInfo(path, context);
		if (info.ok) return ok(true);
		return info.error.code === "not_found" ? ok(false) : err(info.error);
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const info = await this.fileInfo(path, context);
		return info.ok ? ok(info.value.path) : err(info.error);
	}

	/** Stored descendants, plus virtual fixed directories that belong in the root listing. */
	async #below(tx: FileTx, dir: string) {
		const entries = await tx.below(dir);
		if (dir === "/" && !entries.some(([path]) => path === WORKSPACE)) entries.push([WORKSPACE, DIRECTORY]);
		return entries;
	}

	/** The entries of the directory `dir`, by name. */
	async #children(tx: FileTx, dir: string): Promise<Result<FileInfo[], FileError>> {
		const entry = await this.#get(tx, dir);
		if (!entry) return notFound(dir);
		if (entry.kind !== "directory") return fail("not_directory", `Not a directory: ${dir}`, dir);
		const children = (await this.#below(tx, dir)).filter(([path]) => parentOf(path) === dir);
		return ok(children.map(([path, child]) => this.#info(path, child)).sort((a, b) => byName(a.name, b.name)));
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const target = this.#resolve(path);
		return this.#run("readonly", context, target, (tx) => this.#children(tx, target));
	}

	async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const listed = await this.listDir(path, context);
		if (!listed.ok) return err(listed.error);
		const target = this.#resolve(path);
		const paths = listed.value.map((info) => info.path);
		let next = 0;
		let closed = false;
		return ok({
			next: async (maxEntries, ctx) => {
				if (closed) return fail("invalid", "Directory reader is closed", target);
				if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) return fail("invalid", "maxEntries must be a positive integer", target);
				const stop = aborted<{ entries: FileInfo[]; done: boolean }>(ctx, target);
				if (stop) return stop;
				const entries: FileInfo[] = [];
				while (next < paths.length && entries.length < maxEntries) {
					// An entry removed since the reader opened is skipped.
					const info = await this.fileInfo(paths[next++]!, ctx);
					if (info.ok) entries.push(info.value);
					else if (info.error.code !== "not_found") return err(info.error);
				}
				return ok({ entries, done: next >= paths.length });
			},
			close: async () => {
				closed = true;
			},
		});
	}

	async listFiles(path: string, options: ListFilesOptions | undefined, context: Context): Promise<Result<FileListing, FileError>> {
		const target = this.#resolve(path);
		const maxEntries = options?.maxEntries ?? 50_000;
		const maxBytes = options?.maxBytes ?? 4 * 1024 * 1024;
		const timeoutMs = options?.timeoutMs ?? 10_000;
		if (!isCount(maxEntries) || !isCount(maxBytes) || maxBytes > 15.9 * 1024 * 1024 || !isCount(timeoutMs)) {
			return fail("invalid", "Invalid listing bounds", target);
		}
		const skip = new Set([".git", ...(options?.exclude ?? [])]);
		const hidden = options?.hidden ?? true;
		const deadline = performance.now() + timeoutMs;
		const expired = () => performance.now() >= deadline;
		return this.#run("readonly", context, target, async (tx) => {
			const root = await this.#get(tx, target);
			if (!root) return notFound(target);
			if (root.kind !== "directory") return fail("not_directory", `Not a directory: ${target}`, target);
			const stop = aborted<FileListing>(context, target);
			if (stop) return stop;
			if (expired()) return ok({ entries: [], truncated: true });
			const items = await this.#below(tx, target);
			const afterRead = aborted<FileListing>(context, target);
			if (afterRead) return afterRead;
			if (expired()) return ok({ entries: [], truncated: true });
			const below = new Map<string, (readonly [string, Entry])[]>();
			for (const item of items) {
				if (expired()) return ok({ entries: [], truncated: true });
				const parent = parentOf(item[0]);
				let bucket = below.get(parent);
				if (!bucket) below.set(parent, bucket = []);
				bucket.push(item);
			}
			const entries: FileListEntry[] = [];
			let bytes = 0;
			const walk = (dir: string): boolean => {
				const children = (below.get(dir) ?? []).sort((a, b) => byName(nameOf(a[0]), nameOf(b[0])));
				for (const [childPath, entry] of children) {
					if (expired()) return false;
					const name = nameOf(childPath);
					if (skip.has(name) || (!hidden && name.startsWith("."))) continue;
					const relative = childPath.slice(prefixOf(target).length);
					const cost = encoder.encode(relative).length + 2;
					if (entries.length >= maxEntries || bytes + cost > maxBytes) return false;
					entries.push({ path: relative, kind: entry.kind });
					bytes += cost;
					if (entry.kind === "directory" && !walk(childPath)) return false;
				}
				return true;
			};
			const complete = walk(target);
			return ok({ entries, truncated: !complete });
		});
	}

	async watch(): Promise<Result<FileWatcher, FileError>> {
		return fail("not_supported", "This file system does not report changes");
	}

	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const target = this.#resolve(path);
		const recursive = options?.recursive ?? true;
		return this.#run("readwrite", context, target, async (tx) => {
			const entry = await this.#get(tx, target);
			if (entry?.kind === "directory") return recursive ? ok(undefined) : fail("invalid", `File exists: ${target}`, target);
			if (entry) return fail("invalid", `File exists: ${target}`, target);
			const parents = await this.#missingParents(tx, target);
			if (!parents.ok) return parents;
			if (parents.value.length > 0 && !recursive) return notFound(parentOf(target));
			this.#createDirs(tx, [target, ...parents.value]);
			return ok(undefined);
		});
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const target = this.#resolve(path);
		return this.#run("readwrite", context, target, async (tx) => {
			const entry = await this.#get(tx, target);
			if (!entry) return options?.force ? ok(undefined) : notFound(target);
			if (this.#fixed(target)) return fail("permission_denied", `Cannot remove ${target}`, target);
			if (entry.kind === "directory") {
				if (!options?.recursive) return fail("is_directory", `Is a directory: ${target}`, target);
				for (const [below] of await tx.below(target)) tx.delete(below);
			}
			tx.delete(target);
			return ok(undefined);
		});
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const dir = `/tmp/${(prefix ?? "tmp-").replace(/\//g, "-")}${crypto.randomUUID().slice(0, 8)}`;
		const created = await this.createDir(dir, { recursive: true }, context);
		return created.ok ? ok(dir) : err(created.error);
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-", context);
		if (!dir.ok) return dir;
		const file = `${dir.value}/${options?.prefix ?? ""}${crypto.randomUUID()}${options?.suffix ?? ""}`;
		const written = await this.writeFile(file, "", context);
		return written.ok ? ok(file) : err(written.error);
	}

	async exec(
		_command: string | readonly string[],
		_options: ShellExecOptions | undefined,
		_context: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return err(
			new ExecutionError(
				"shell_unavailable",
				"There is no shell here. Process files with JavaScript in codemode (tools.read, tools.write, tools.ls) instead.",
			),
		);
	}

	async cleanup(_context: Context): Promise<void> {}

	// ── For the panel ──

	/** Every file below `/workspace`, by path relative to it. */
	async workspaceFiles(context: Context): Promise<Result<WorkspaceFile[], FileError>> {
		return this.#run("readonly", context, WORKSPACE, async (tx) =>
			ok(
				(await tx.below(WORKSPACE))
					.filter(([, entry]) => entry.kind === "file")
					.map(([path, entry]) => ({ path: path.slice(WORKSPACE.length + 1), size: entry.size, mtimeMs: entry.mtimeMs }))
					.sort((a, b) => byName(a.path, b.path)),
			),
		);
	}
}
