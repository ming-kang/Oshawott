// Chromium JSON-serializes Port messages, so bytes travel as base64. `disconnect()` emits no local
// `onDisconnect`, hence the explicit close notification below.

import { fromBase64, toBase64 } from "../lib/base64.ts";
import type { Link } from "../lib/chord.ts";
import type { RuntimePort } from "../platform/webext.ts";

export interface PortLink extends Link {
	readonly closed: boolean;
	/** Why the port closed, when the browser said (Firefox: `port.error`, Chromium: `runtime.lastError`). */
	readonly reason: string | undefined;
	/**
	 * Settles when the link closed, with its reason. For the app: Chord owns the one `onClose` listener of a link it
	 * was given, so code that reconnects waits on this instead.
	 */
	readonly done: Promise<string | undefined>;
}

const FRAGMENT = "oshawott:fragment:v1:";
/** Chromium rejects whole Port messages around 64 MiB; fragments stay far below it, including base64 overhead. */
const FRAGMENT_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024;

/** The one message being reassembled: a sender posts all fragments of a message before anything else, in order. */
type Assembly = { id: string; count: number; chunks: Uint8Array[]; bytes: number };

export function portLink(port: RuntimePort, lastError: () => string | undefined = () => undefined): PortLink {
	let closed = false;
	let reason: string | undefined;
	let listener: ((message: Uint8Array) => void) | undefined;
	let queued: Uint8Array[] = [];
	let closeListener: (() => void) | undefined;
	let fragmentId = 0;
	let assembly: Assembly | undefined;
	let settle: (reason: string | undefined) => void = () => {};
	const done = new Promise<string | undefined>((resolve) => (settle = resolve));

	const end = (why?: string) => {
		if (closed) return;
		closed = true;
		reason = why;
		port.onMessage.removeListener(receive);
		port.onDisconnect.removeListener(disconnected);
		listener = undefined;
		queued = [];
		assembly = undefined;
		const notify = closeListener;
		closeListener = undefined;
		notify?.();
		settle(why);
	};
	const disconnected = () => end(port.error?.message ?? lastError() ?? "disconnected");
	const deliver = (message: Uint8Array) => {
		if (listener === undefined) queued.push(message);
		else listener(message);
	};
	const receive = (data: unknown) => {
		if (closed) return;
		if (typeof data !== "string") {
			close("unexpected message");
			return;
		}
		if (!data.startsWith(FRAGMENT)) {
			if (assembly) {
				close("invalid fragment sequence");
				return;
			}
			deliver(fromBase64(data));
			return;
		}
		const rest = data.slice(FRAGMENT.length);
		const header = /^([^:]+):(\d+):(\d+):/.exec(rest);
		const id = header?.[1];
		const index = Number(header?.[2]);
		const count = Number(header?.[3]);
		if (!header || !id || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 0 || count < 1 || index >= count || count > Math.ceil(MAX_MESSAGE_BYTES / FRAGMENT_BYTES)) {
			close("invalid fragment");
			return;
		}
		let payload: Uint8Array;
		try {
			payload = fromBase64(rest.slice(header[0].length));
		} catch {
			close("invalid fragment bytes");
			return;
		}
		const state = assembly ?? (index === 0 ? { id, count, chunks: [], bytes: 0 } : undefined);
		if (!state || state.id !== id || state.count !== count || index !== state.chunks.length
			|| payload.length > FRAGMENT_BYTES || state.bytes + payload.length > MAX_MESSAGE_BYTES) {
			close("invalid fragment sequence");
			return;
		}
		state.chunks.push(payload);
		state.bytes += payload.length;
		assembly = state;
		if (state.chunks.length !== count) return;
		assembly = undefined;
		const message = new Uint8Array(state.bytes);
		let offset = 0;
		for (const chunk of state.chunks) {
			message.set(chunk, offset);
			offset += chunk.length;
		}
		deliver(message);
	};
	const close = (why: string) => {
		if (closed) return;
		try {
			port.disconnect();
		} catch {}
		end(why);
	};

	port.onMessage.addListener(receive);
	port.onDisconnect.addListener(disconnected);

	return {
		get closed() {
			return closed;
		},
		get reason() {
			return reason;
		},
		done,
		send(message) {
			if (closed) return;
			try {
				if (message.length <= FRAGMENT_BYTES) {
					port.postMessage(toBase64(message));
					return;
				}
				if (message.length > MAX_MESSAGE_BYTES) throw new Error("The extension message exceeds 512 MiB");
				const id = String(++fragmentId);
				const count = Math.ceil(message.length / FRAGMENT_BYTES);
				for (let index = 0; index < count; index++) {
					const payload = toBase64(message.subarray(index * FRAGMENT_BYTES, (index + 1) * FRAGMENT_BYTES));
					port.postMessage(`${FRAGMENT}${id}:${index}:${count}:${payload}`);
				}
			} catch (error) {
				// Firefox throws on a port its peer closed, Chromium on a disconnected one; the failure may also be local (an
				// oversized message) or follow some fragments already sent. Disconnect either way, so the peer ends too.
				close(error instanceof Error ? error.message : String(error));
			}
		},
		onMessage(next) {
			if (closed) return;
			listener = next;
			for (const message of queued.splice(0)) {
				if (closed) return;
				next(message);
			}
		},
		close() {
			close("closed");
		},
		onClose(next) {
			if (closed) next();
			else closeListener = next;
		},
	};
}
