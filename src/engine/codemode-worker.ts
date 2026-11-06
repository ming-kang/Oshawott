// The code mode Worker: runs one execution's QuickJS VM and forwards its messages to the Engine.
import { type CodemodeRemoteReply, serveCodemodeRemote } from "@earendil-works/pi-codemode/portable";
import type { FromWorker, ToWorker } from "./codemode.ts";

/** The Worker global this module runs in (typed without the webworker lib, which conflicts with the DOM one). */
const scope = self as unknown as {
	readonly location: Location;
	postMessage(message: FromWorker): void;
	onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};
const wasm = WebAssembly.compileStreaming(fetch(new URL("quickjs.wasm", scope.location.href)));
const pending = new Map<number, (reply: CodemodeRemoteReply) => void>();
let next = 0;

const post = (message: FromWorker) => scope.postMessage(message);

scope.onmessage = ({ data }: MessageEvent<ToWorker>) => {
	if (data.type === "reply") {
		pending.get(data.id)?.(data.reply);
		pending.delete(data.id);
		return;
	}
	void serveCodemodeRemote(
		data.request,
		(messages) =>
			new Promise<CodemodeRemoteReply>((resolve) => {
				const id = next++;
				pending.set(id, resolve);
				post({ type: "exchange", id, messages });
			}),
		{ wasm, maxMemoryLimitBytes: 128 * 1024 * 1024 },
	).finally(() => post({ type: "done" }));
};
