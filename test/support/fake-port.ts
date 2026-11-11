// Two connected `runtime.Port` ends with the browsers' semantics that matter to `portLink`: messages are delivered
// asynchronously and in order, serialized as JSON (Chromium), `disconnect()` fires `onDisconnect` on the other end
// only, and posting on a disconnected port throws.
import type { RuntimePort, WebExtEvent } from "../../src/platform/webext.ts";

class FakeEvent<L extends (...args: never[]) => unknown> implements WebExtEvent<L> {
	readonly listeners = new Set<L>();
	addListener(listener: L) {
		this.listeners.add(listener);
	}
	removeListener(listener: L) {
		this.listeners.delete(listener);
	}
	emit(...args: Parameters<L>) {
		for (const listener of [...this.listeners]) listener(...args);
	}
}

export interface FakePort extends RuntimePort {
	readonly sent: number;
}

interface End extends FakePort {
	peer: End;
	connected: boolean;
	sent: number;
	readonly onMessage: FakeEvent<(message: unknown, port: RuntimePort) => void>;
	readonly onDisconnect: FakeEvent<(port: RuntimePort) => void>;
}

export function fakePortPair(name = "test"): [FakePort, FakePort] {
	const make = (): End => {
		const port: End = {
			name,
			peer: undefined as unknown as End,
			connected: true,
			sent: 0,
			onMessage: new FakeEvent<(message: unknown, port: RuntimePort) => void>(),
			onDisconnect: new FakeEvent<(port: RuntimePort) => void>(),
			postMessage(message: unknown) {
				if (!port.connected) throw new Error("Attempting to use a disconnected port object");
				port.sent++;
				const wire = JSON.stringify(message);
				setTimeout(() => {
					if (port.peer.connected) port.peer.onMessage.emit(JSON.parse(wire), port.peer);
				}, 0);
			},
			disconnect() {
				if (!port.connected) return;
				port.connected = false;
				const peer = port.peer;
				setTimeout(() => {
					if (!peer.connected) return;
					peer.connected = false;
					peer.onDisconnect.emit(peer);
				}, 0);
			},
		};
		return port;
	};
	const a = make();
	const b = make();
	a.peer = b;
	b.peer = a;
	return [a, b];
}
