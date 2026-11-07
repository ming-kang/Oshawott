// This is the only `runtime.onConnect` receiver: Firefox drops a port when any receiving context unloads,
// and a Chromium offscreen document cannot initiate `tabs.connect`.
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createModels } from "@earendil-works/pi-ai";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { Browser } from "../contracts/browser.ts";
import { PORTS } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, type Context, type Link } from "../lib/chord.ts";
import { type PortLink, portLink } from "../link/port-link.ts";
import { ext, type RuntimePort } from "../platform/webext.ts";
import type { PageToolName } from "../tools/page-tools.ts";

import { workerCodemodeSandbox } from "./codemode.ts";
import { IndexedDbCredentialStore } from "./credentials.ts";
import { type Engine, startEngine } from "./engine.ts";
import { ChatFiles } from "./files.ts";
import { IndexedDbFileBackend } from "./files-idb.ts";
import { callPage, using } from "./tools.ts";

const ATTACH_TIMEOUT_MS = 10_000;

/** Port events are not buffered, so incoming ports become links immediately and wait here for their consumers. */
export class Arrivals<K> {
	#links = new Map<K, PortLink>();
	#waiters = new Map<K, (link: PortLink) => void>();

	arrive(key: K, link: PortLink) {
		const waiter = this.#waiters.get(key);
		this.#waiters.delete(key);
		if (waiter) return waiter(link);
		this.#links.get(key)?.close();
		this.#links.set(key, link);
		void link.done.then(() => {
			if (this.#links.get(key) === link) this.#links.delete(key);
		});
	}

	/** The port that already arrived for `key`, or the one `summon` makes arrive within `ms`. */
	async obtain(key: K, ms: number, context: Context, summon: () => Promise<unknown>): Promise<PortLink> {
		const ready = this.#links.get(key);
		this.#links.delete(key);
		if (ready && !ready.closed) return ready;
		const arriving = this.#wait(key, ms, context);
		await summon();
		return await arriving;
	}

	#wait(key: K, ms: number, context: Context): Promise<PortLink> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#waiters.delete(key);
				reject(new Error(`No port for ${String(key)} within ${ms} ms`));
			}, ms);
			context.abortSignal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
			this.#waiters.set(key, (link) => {
				clearTimeout(timer);
				resolve(link);
			});
		});
	}
}

const lastError = () => ext.runtime.lastError?.message;

export interface BrowserEngineOptions {
	readonly broker: (context: Context, brokerPorts: Arrivals<"broker">) => Promise<Link>;
}

export async function runEngine(options: BrowserEngineOptions): Promise<Engine> {
	const context = BACKGROUND_CONTEXT;
	const tabs = new Arrivals<number>();
	const brokers = new Arrivals<"broker">();
	let engine: Engine | undefined;
	const panels: { link: PortLink; instance: string }[] = [];
	const extensionPage = (port: RuntimePort, path: string) =>
		port.sender?.id === ext.runtime.id && port.sender.url?.startsWith(ext.runtime.getURL(path)) === true;

	// Registered synchronously, before anything awaits: a port that wakes this document must find its listener.
	ext.runtime.onConnect.addListener((port) => {
		if (port.name === PORTS.tab) {
			const tabId = port.sender?.tab?.id;
			if (tabId === undefined || port.sender?.frameId !== 0) return port.disconnect();
			tabs.arrive(tabId, portLink(port, lastError));
		} else if (port.name === PORTS.panel) {
			if (!extensionPage(port, "panel.html")) return port.disconnect();
			const panel = { link: portLink(port, lastError), instance: port.sender?.documentId ?? crypto.randomUUID() };
			if (engine) engine.acceptPanel(panel.link, panel.instance);
			else panels.push(panel);
		} else if (port.name === PORTS.broker) {
			if (port.sender?.id !== ext.runtime.id || port.sender.tab !== undefined) return port.disconnect();
			brokers.arrive("broker", portLink(port, lastError));
		} else port.disconnect();
	});

	// One Engine per profile: a second document (a restart overlapping the old one) waits for the first to let go.
	await new Promise<void>((acquired) => {
		void navigator.locks.request("oshawott:engine", () => {
			acquired();
			return new Promise(() => {});
		});
	});
	void navigator.storage?.persist?.();

	const credentials = new IndexedDbCredentialStore();
	const models = createModels({
		credentials,
		authContext: { env: async () => undefined, fileExists: async () => false },
	});
	for (const provider of [anthropicProvider(), openaiProvider(), googleProvider(), openrouterProvider(), deepseekProvider()]) {
		models.setProvider(provider);
	}
	if (__OSHAWOTT_DEV__) models.setProvider((await import("./demo.ts")).demoProvider());

	const sandbox = workerCodemodeSandbox(new URL("codemode-worker.js", location.href));
	const files = await IndexedDbFileBackend.open();
	engine = await startEngine(
		{
			storage: await IndexedDbStorage.open("oshawott"),
			models,
			credentials,
			files,
			broker: (ctx) => options.broker(ctx, brokers),
			tab: (tabId, ctx) =>
				tabs.obtain(tabId, ATTACH_TIMEOUT_MS, ctx, () =>
					using(engine!.host, Browser, {}, ctx, (browser) => browser.attach({ tabId }, ctx))),
			extensions: [createCodemodeExtension({ sandbox })],
		},
		context,
	);
	for (const panel of panels.splice(0)) engine.acceptPanel(panel.link, panel.instance);

	const started = engine;
	(globalThis as { oshawott?: unknown }).oshawott = {
		engine: started,
		codemode: (code: string) => sandbox.execute(code),
		files: (chat: number) => new ChatFiles(files, chat),
		page: (tabId: number, tool: PageToolName, args: Record<string, unknown>) => callPage(started.host, tabId, tool, args, context),
	};
	return engine;
}
