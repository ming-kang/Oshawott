// The tools on a chat's files and the web, as one Durable extension: pi-durable's `read`, `write` and `edit` over the
// chat's `ChatFiles` (the Harness's `env`), Oshawott's `ls`, and `fetch`. Code mode scripts call the same tools
// (`await tools.read({ path })`), which is how the model searches, parses and transforms files without a shell.
//
// `fetch` runs in the Engine's document, without cookies, and only on sites the user has allowed (the Broker checks the
// host permission): the permission that lets page tools act on a site lets the model read it from the network too.
import { defineExtension, defineTool, type Extension, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { Browser, NO_ACCESS } from "../contracts/browser.ts";
import type { Principal } from "../contracts/hosts.ts";
import { arr, bool, int, map, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import type { Host } from "../lib/chord.ts";
import { ChatFiles, MAX_FILE_BYTES } from "./files.ts";
import { using } from "./tools.ts";

export { NO_ACCESS };
export const FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 20_000;
const MAX_LISTED = 1_000;
export const MAX_READ_CHARS = 1_000_000;

const text = (value: string) => [{ type: "text" as const, text: value }];

function envOf(api: ToolExecutionApi): ChatFiles {
	if (!(api.env instanceof ChatFiles)) throw new Error("This chat has no files.");
	return api.env;
}

const lsTool = defineTool({
	name: "ls",
	description:
		"List the files and directories below a directory of this chat's files, at any depth, with file sizes. Directories end in /.",
	parameters: obj({ path: opt(str({ description: "Directory to list (relative or absolute); default the working directory." })) }),
	structuredOutputSchema: arr(obj({ path: str(), kind: oneOf(["file", "directory"]), size: int() })),
	replay: "safe",
	execute: async (args, api, context) => {
		const env = envOf(api);
		const root = getOrThrow(await env.absolutePath(args.path ?? ".", context));
		const listed = getOrThrow(await env.listTree(root, context)).slice(0, MAX_LISTED)
			.map(({ path, kind, size }) => ({ path, kind, size }));
		const lines = listed.map((entry) => (entry.kind === "directory" ? `${entry.path}/` : `${entry.path}  (${entry.size} bytes)`));
		if (listed.length >= MAX_LISTED) lines.push(`[Stopped at ${MAX_LISTED} entries.]`);
		return { output: text(lines.length ? lines.join("\n") : `${root} is empty.`), structuredOutput: listed };
	},
});

/** Programs need complete data, not `read`'s 50 KiB line preview. Keep each result bounded and out of model tools. */
const readTextTool = defineTool({
	name: "read_text",
	description: "Read complete text for a code mode program, including large single lines, in bounded character chunks. " +
		"Use offset and concatenate text until eof. Offsets count decoded UTF-16 code units, not bytes. Default encoding UTF-8; a leading BOM is stripped. Each call reads the current file.",
	parameters: obj({
		path: str({ description: "File path in this chat." }),
		offset: opt(int({ minimum: 0, description: "Character offset, default 0; use nextOffset for the next chunk." })),
		maxChars: opt(int({ minimum: 1, maximum: MAX_READ_CHARS, description: "Characters per chunk, default 1,000,000." })),
		encoding: opt(str({ description: "TextDecoder encoding label, default utf-8." })),
	}),
	structuredOutputSchema: obj({ text: str(), offset: int(), nextOffset: int(), totalChars: int(), eof: bool() }),
	callers: ["tools"],
	replay: "safe",
	execute: async (args, api, context) => {
		const bytes = getOrThrow(await envOf(api).readBinaryFile(args.path, context));
		const source = new TextDecoder(args.encoding ?? "utf-8", { fatal: true }).decode(bytes);
		const start = Math.min(args.offset ?? 0, source.length);
		const end = Math.min(start + (args.maxChars ?? MAX_READ_CHARS), source.length);
		return {
			output: text(`Read ${end - start} characters of ${source.length} from ${args.path} at offset ${start}.`),
			structuredOutput: { text: source.slice(start, end), offset: start, nextOffset: end, totalChars: source.length, eof: end === source.length },
		};
	},
});

const TEXTUAL = /^text\/|[/+](json|xml)\b|javascript|ecmascript|csv|yaml|toml|x-www-form-urlencoded/i;

/** The body as text: by its content type and charset, or, without a content type, if it is valid UTF-8. */
function decodeBody(contentType: string, body: Uint8Array): string | undefined {
	if (TEXTUAL.test(contentType)) {
		const charset = /charset="?([\w-]+)/i.exec(contentType)?.[1];
		try {
			return new TextDecoder(charset ?? "utf-8").decode(body);
		} catch {
			return new TextDecoder().decode(body);
		}
	}
	if (contentType) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(body);
	} catch {
		return undefined;
	}
}

async function readBody(response: Response, limit: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			throw new Error(`The response is larger than ${limit / 1024 / 1024} MiB.`);
		}
		chunks.push(value);
	}
	const body = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.length;
	}
	return body;
}

export interface FilesToolsOptions {
	readonly host: Host<Principal>;
	readonly fetch: typeof fetch;
}

function fetchTool({ host, fetch: request }: FilesToolsOptions) {
	return defineTool({
		name: "fetch",
		description:
			"Request a URL over HTTP(S), without the user's cookies or logins. Returns the status and the body as text, " +
			`at most maxChars characters (default ${DEFAULT_MAX_CHARS}); with saveTo, saves the whole body (any type, ` +
			`up to ${MAX_FILE_BYTES / 1024 / 1024} MiB) to that file instead. Only sites the user has allowed: on another ` +
			"site the call fails, and the user can allow it from the panel. Redirects are refused: request the final URL directly.",
		parameters: obj({
			url: str({ description: "An http or https URL." }),
			method: opt(oneOf(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])),
			headers: opt(map(str())),
			body: opt(str({ description: "Request body, as text." })),
			saveTo: opt(str({ description: "File to save the whole response body to (relative or absolute)." })),
			maxChars: opt(int({ minimum: 1, maximum: 1_000_000 })),
		}),
		structuredOutputSchema: obj({
			status: int(),
			statusText: str(),
			url: str(),
			contentType: str(),
			bytes: int(),
			body: opt(str()),
			truncated: opt(bool()),
			savedTo: opt(str()),
		}),
		// POST, PUT, DELETE and saving a body may have effects; never repeat a cut-off call automatically.
		replay: "unsafe",
		execute: async (args, api, context) => {
			let url: URL;
			try {
				url = new URL(args.url);
			} catch {
				throw new Error(`Not a URL: ${args.url}`);
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs can be fetched.");
			const allowed = await using(host, Browser, {}, context, (browser) => browser.hasAccess({ url: url.href }, context));
			if (!allowed) {
				throw new Error(
					`${NO_ACCESS} ${url.host}: the user has not allowed Oshawott on this site. They can allow it from this call in the panel; then try again.`,
				);
			}
			const method = args.method ?? "GET";
			const signals = [AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(context.abortSignal ? [context.abortSignal] : [])];
			let response: Response;
			try {
				response = await request(url.href, {
					method,
					...(args.headers ? { headers: args.headers } : {}),
					...(args.body !== undefined && method !== "GET" && method !== "HEAD" ? { body: args.body } : {}),
					credentials: "omit",
					cache: "no-store",
					// A browser cannot inspect an opaque manual redirect before following it. Refuse redirects rather
					// than make an unchecked request to a site the user did not allow.
					redirect: "error",
					referrerPolicy: "no-referrer",
					signal: AbortSignal.any(signals),
				});
			} catch (error) {
				if ((error as Error)?.name === "TimeoutError") throw new Error(`No response from ${url.host} within ${FETCH_TIMEOUT_MS / 1000} s.`);
				if ((error as Error)?.name === "TypeError") {
					throw new Error(`Could not fetch ${url.host}: ${(error as Error).message}. Redirects are not followed; request the final URL directly.`, { cause: error });
				}
				throw error;
			}
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				throw new Error("Redirects are not followed; request the final URL directly.");
			}
			const body = method === "HEAD" ? new Uint8Array() : await readBody(response, MAX_FILE_BYTES);
			const contentType = response.headers.get("content-type") ?? "";
			const summary = {
				status: response.status,
				statusText: response.statusText,
				url: response.url || url.href,
				contentType,
				bytes: body.length,
			};
			const head = [`HTTP ${response.status} ${response.statusText}`.trim(), contentType || "no content type", `${body.length} bytes`];
			if (summary.url !== url.href) head.push(`from ${summary.url}`);
			const line = head.join(" · ");

			if (args.saveTo !== undefined) {
				const env = envOf(api);
				const path = getOrThrow(await env.absolutePath(args.saveTo, context));
				getOrThrow(await env.writeFile(path, body, context));
				return { output: text(`${line}\nSaved the body to ${path}.`), structuredOutput: { ...summary, savedTo: path } };
			}
			const decoded = decodeBody(contentType, body);
			if (decoded === undefined) {
				return {
					output: text(`${line}\nA binary body, not shown: pass saveTo to keep it as a file.`),
					structuredOutput: summary,
				};
			}
			const max = args.maxChars ?? DEFAULT_MAX_CHARS;
			const truncated = decoded.length > max;
			const shown = truncated ? decoded.slice(0, max) : decoded;
			const note = truncated
				? `\n\n[The body is cut at ${max} of ${decoded.length} characters: pass saveTo to keep all of it as a file, or a larger maxChars.]`
				: "";
			return { output: text(`${line}\n\n${shown}${note}`), structuredOutput: { ...summary, body: shown, truncated } };
		},
	});
}

export function filesExtension(options: FilesToolsOptions): Extension {
	return defineExtension({
		name: "oshawott.files",
		sections: [
			section(
				"files",
				() =>
					"This chat has its own files; the working directory is /workspace. They stay across browser restarts and " +
					"are deleted with the chat, and the user can see and download them in the panel. There is no shell: use " +
					"read, write, edit and ls on files, and fetch for the web (saveTo keeps a whole download as a file). To " +
					"search, parse, transform or compute, write a codemode script; it calls the same tools, as in " +
					"`await tools.read({ path })`. For complete text, including huge single-line JSON, use " +
					"`tools.read_text({ path, offset })` and concatenate its text chunks until eof.",
				{ tag: false },
			),
		],
		tools: [createReadTool(), createWriteTool(), createEditTool(), lsTool, readTextTool, fetchTool(options)],
	});
}
