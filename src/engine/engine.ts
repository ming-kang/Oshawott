// The Engine: one Chord host at `EngineHost()` around one Durable Harness. Platform-free: the browser entry passes in
// storage, models, and how to reach the Broker and a tab; tests pass memory ones.
//
// Lifecycle. Every context of an extension can be evicted (a service worker, an offscreen document, a Firefox event
// page). Durable is built for that: a reopened Harness continues from its last commit (`resume()`), and `onWake` says
// when a process is needed again. The Engine forwards `onWake` to the Broker, which arms an alarm; the alarm brings the
// Engine back. Nothing else keeps it alive.
import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import { FileError } from "@earendil-works/pi-durable/env";
import { createRegistry, type Extension, Harness, type Storage, type Wake } from "@earendil-works/pi-durable";
import { Browser } from "../contracts/browser.ts";
import { BrokerHost, EngineHost, type Principal, TabHost } from "../contracts/hosts.ts";
import { type Context, createHost, type Host, type HostError, type Link } from "../lib/chord.ts";
import { WorkspaceDoc } from "./docs.ts";
import { panelFacet } from "./facet.ts";
import { ChatFiles, type FileBackend, resolvePath, WORKSPACE } from "./files.ts";
import { resumeFileDeletes } from "./files-lifecycle.ts";
import { filesExtension } from "./files-tools.ts";
import { browserExtension, using } from "./tools.ts";

export interface EngineOptions {
	readonly storage: Storage;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	/** The link to the Broker (Chromium: its service worker's port; Firefox: a memory link in the same page). */
	readonly broker: (context: Context) => Promise<Link>;
	/** The link to the page host of `tabId`; the platform injects the page bundle when the tab has none. */
	readonly tab: (tabId: number, context: Context) => Promise<Link>;
	/** Where the chats' files are kept (IndexedDB in the browser). */
	readonly files: FileBackend;
	/** The network for the `fetch` tool; default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** More extensions, such as code mode with the platform's sandbox. */
	readonly extensions?: readonly Extension[];
	readonly now?: () => number;
	readonly onError?: (error: HostError | unknown) => void;
}

export interface Engine {
	readonly host: Host<Principal>;
	readonly harness: Harness;
	/** A panel connected: its port's link, and an id for this panel instance. */
	acceptPanel(link: Link, instance: string): void;
	close(): Promise<void>;
}

export async function startEngine(options: EngineOptions, context: Context): Promise<Engine> {
	const onError = options.onError ?? ((error: unknown) => console.error("[oshawatt engine]", error));
	const now = options.now ?? Date.now;

	const host = createHost<Principal>({ address: EngineHost(), principal: { kind: "engine" }, onError });
	// Only the Engine's own work reaches the browser and the pages: a panel's hold for them is refused.
	host.route(
		BrokerHost,
		{
			authorize: (principal) => principal.kind === "engine",
			resolve: async (_address, ctx) => ({ link: await options.broker(ctx), principal: { kind: "broker" } }),
		},
		context,
	);
	host.route(
		TabHost,
		{
			authorize: (principal) => principal.kind === "engine",
			resolve: async ({ params: { tabId } }, ctx) => ({
				link: await options.tab(tabId, ctx),
				principal: { kind: "tab", tabId },
			}),
		},
		context,
	);

	const registry = createRegistry();
	registry.install(browserExtension(host));
	registry.install(filesExtension({ host, fetch: options.fetch ?? ((input, init) => fetch(input, init)) }));
	for (const extension of options.extensions ?? []) registry.install(extension);

	let closing = false;
	const armWake = (wake: Wake) => {
		if (closing) return;
		void using(host, Browser, {}, context, (browser) => browser.armWake({ active: wake.active, at: wake.at }, context)).catch(
			(error) => {
				if (!closing) onError(error);
			},
		);
	};

	const harness: Harness = await Harness.open(
		options.storage,
		{
			models: options.models,
			registry,
			// Authorize against the current workspace, not a task's possibly older phase snapshot. Old tool handles
			// check again at each filesystem operation; a removed chat cannot write after its files are cleared.
			env: async ({ conversationId, cwd }, ctx) => {
				const requireActive = async (ctx: Context) => {
					const workspace = await harness.snapshot(WorkspaceDoc, ctx);
					if (!workspace?.chats.some((chat) => chat.id === conversationId)) {
						throw new FileError("permission_denied", `No chat ${conversationId}`);
					}
				};
				await requireActive(ctx);
				const files = new ChatFiles(options.files, conversationId, now, requireActive);
				if (cwd !== undefined) files.cwd = resolvePath(WORKSPACE, cwd);
				return files;
			},
			identity: { attribution: { name: "Oshawatt", url: "https://github.com/" } },
			onWake: armWake,
			onReport: (report) => onError(report),
		},
		context,
	);
	// The workspace document exists before anything follows it.
	await harness.commit(async (tx) => {
		await tx.doc(WorkspaceDoc);
	}, context);

	await resumeFileDeletes(harness, options.files, context, onError);
	await host.load(
		[
			{
				name: "oshawatt.panel",
				facet: panelFacet({ harness, models: options.models, credentials: options.credentials, files: options.files, now }),
			},
		],
		context,
	);
	harness.resume();

	return {
		host,
		harness,
		acceptPanel(link, instance) {
			host.accept(link, { principal: { kind: "panel", instance } }, context);
		},
		async close() {
			// Links first: holders go `loading` and re-hold on the next Engine, instead of seeing their objects fail.
			closing = true;
			await host.close(context);
			try {
				await harness.close(context);
			} finally {
				options.files.close?.();
			}
		},
	};
}
