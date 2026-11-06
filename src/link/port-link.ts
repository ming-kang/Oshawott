// A Chord link over a WebExtension `runtime.Port`.
//
// Chord's links move whole `Uint8Array` messages in order and close both ends. A Port moves messages in order too, but
// Chromium serializes them as JSON (a Uint8Array would arrive as an object of indexes), so every message travels as one
// base64 string. Firefox would structured-clone bytes; one encoding keeps one code path.
//
// The Port's own events give the rest: `onDisconnect` is the peer's close, and `disconnect()` closes our end without an
// event on it, so the close listener is run here.

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

export function portLink(port: RuntimePort, lastError: () => string | undefined = () => undefined): PortLink {
	let closed = false;
	let reason: string | undefined;
	let listener: ((message: Uint8Array) => void) | undefined;
	let queued: Uint8Array[] = [];
	let closeListener: (() => void) | undefined;
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
		const notify = closeListener;
		closeListener = undefined;
		notify?.();
		settle(why);
	};
	const disconnected = () => end(port.error?.message ?? lastError() ?? "disconnected");
	const receive = (data: unknown) => {
		if (closed) return;
		if (typeof data !== "string") {
			// Not ours: a Port carries only this link's frames.
			close("unexpected message");
			return;
		}
		const message = fromBase64(data);
		if (listener === undefined) queued.push(message);
		else listener(message);
	};
	const close = (why: string) => {
		if (closed) return;
		try {
			port.disconnect();
		} catch {
			// Already gone.
		}
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
				port.postMessage(toBase64(message));
			} catch (error) {
				// Firefox throws on a port its peer closed; Chromium throws on a disconnected one.
				end(error instanceof Error ? error.message : String(error));
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

const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
	const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
	if (native) return native.call(bytes);
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
	const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
	if (native) return native(text);
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
