// Code mode's VM in a dedicated Worker, one per execution: the Engine keeps the tools and the call records
// (`RemoteCodemodeSandbox`), the Worker only runs QuickJS (`serveCodemodeRemote`). A script that computes never blocks
// the Engine, and a stopped execution's Worker is terminated outright. Needs no SharedArrayBuffer, so it works in a
// Firefox event page as in a Chromium offscreen document; the extension CSP allows `wasm-unsafe-eval` for QuickJS.
import {
	type CodemodeRemote,
	type CodemodeRemoteMessage,
	type CodemodeRemoteReply,
	type CodemodeRemoteRequest,
	RemoteCodemodeSandbox,
} from "@earendil-works/pi-codemode/portable";

export type ToWorker =
	| { readonly type: "execute"; readonly request: CodemodeRemoteRequest }
	| { readonly type: "reply"; readonly id: number; readonly reply: CodemodeRemoteReply };
export type FromWorker =
	| { readonly type: "exchange"; readonly id: number; readonly messages: CodemodeRemoteMessage[] }
	| { readonly type: "done" };

function workerRemote(url: URL): CodemodeRemote {
	return {
		execute(request, exchange) {
			return new Promise<void>((resolve, reject) => {
				const worker = new Worker(url, { type: "module" });
				const finish = (error?: unknown) => {
					worker.terminate();
					if (error === undefined) resolve();
					else reject(error);
				};
				worker.onerror = (event) => finish(new Error(event.message || "code mode worker failed"));
				worker.onmessage = async ({ data }: MessageEvent<FromWorker>) => {
					if (data.type === "done") return finish();
					try {
						const reply = await exchange(data.messages);
						worker.postMessage({ type: "reply", id: data.id, reply } satisfies ToWorker);
						if (reply?.type === "stop") finish();
					} catch (error) {
						finish(error);
					}
				};
				worker.postMessage({ type: "execute", request } satisfies ToWorker);
			});
		},
	};
}

export function workerCodemodeSandbox(workerUrl: URL) {
	return new RemoteCodemodeSandbox({ remote: () => workerRemote(workerUrl), timeoutMs: 120_000 });
}
