import type { CredentialStore, ModelsStore, MutableModels } from "@earendil-works/pi-ai";
import { FileError } from "@earendil-works/pi-durable/env";
import { createRegistry, type Extension, Harness, type Storage, type Wake } from "@earendil-works/pi-durable";
import { Browser } from "../contracts/browser.ts";
import { PANEL_LINK_LIMITS } from "../contracts/chat.ts";
import { BrokerHost, EngineHost, type Principal, TabHost } from "../contracts/hosts.ts";
import { type Context, createHost, type Host, type HostError, type Link } from "../lib/chord.ts";
import { completeAttachmentDeletes } from "./attachments.ts";
import { ConversationActivity } from "./activity.ts";
import { ProvidersDoc, WorkspaceDoc, type WorkspaceState } from "./docs.ts";
import { panelFacet } from "./facet.ts";
import { writeInstructions } from "./instructions.ts";
import { ChatTitles, TITLE_TIMEOUT_MS } from "./titles.ts";
import { ProviderManager } from "./providers.ts";
import { ChatFiles, type FileBackend, resolvePath, WORKSPACE } from "./files.ts";
import { resumeFileDeletes } from "./files-lifecycle.ts";
import { filesExtension } from "./files-tools.ts";
import { browserExtension, using } from "./tools.ts";

export interface EngineOptions {
	readonly storage: Storage;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly modelsStore?: ModelsStore;
	readonly broker: (context: Context) => Promise<Link>;
	readonly tab: (tabId: number, context: Context) => Promise<Link>;
	readonly files: FileBackend;
	readonly fetch?: typeof fetch;
	readonly extensions?: readonly Extension[];
	readonly now?: () => number;
	/** Test hook for the bounded title request; production uses 15 seconds. */
	readonly titleTimeoutMs?: number;
	readonly onError?: (error: HostError | unknown) => void;
}

export interface Engine {
	readonly host: Host<Principal>;
	readonly harness: Harness;
	acceptPanel(link: Link, instance: string): void;
	close(): Promise<void>;
}

export async function startEngine(options: EngineOptions, context: Context): Promise<Engine> {
	const onError = options.onError ?? ((error: unknown) => console.error("[oshawott engine]", error));
	const now = options.now ?? Date.now;
	const providers = new ProviderManager({ models: options.models, modelsStore: options.modelsStore, fetch: options.fetch });

	const host = createHost<Principal>({ address: EngineHost(), principal: { kind: "engine" }, onError });
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

	/** Set from the stored Workspace before scheduling starts; the defaults only cover the open itself. */
	let execution = { autoCompaction: true, autoRetry: true };
	const harness: Harness = await Harness.open(
		options.storage,
		{
			models: options.models,
			registry,
			settings: () => ({
				retry: { enabled: execution.autoRetry },
				compaction: { enabled: execution.autoCompaction },
				afterFailedRun: "keep",
			}),
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
			identity: { attribution: { name: "Oshawott", url: "https://github.com/" } },
			onWake: armWake,
			onReport: (report) => onError(report),
		},
		context,
	);
	await harness.commit(async (tx) => {
		await tx.doc(WorkspaceDoc);
		await tx.doc(ProvidersDoc);
	}, context);
	// Older workspaces gain the built-in global instructions; later edits update every chat in the same transaction.
	await harness.commit((tx) => writeInstructions(tx), context);
	const storedProviders = await harness.snapshot(ProvidersDoc, context);
	await providers.restore(storedProviders?.custom ?? []);

	// The Engine owns the one Workspace observation: it sets the execution policy and feeds the status projection. It is
	// attached before `harness.resume()`, so no recovered run is scheduled under the defaults instead of the stored policy.
	const activity = new ConversationActivity({ harness, now, onError });
	await activity.start(context);
	const acceptWorkspace = (value: WorkspaceState | undefined, ctx: Context) => {
		execution = { autoCompaction: value?.autoCompaction ?? true, autoRetry: value?.autoRetry ?? true };
		activity.setChats(value?.chats ?? [], ctx);
	};
	let workspaceRevision = 0;
	const workspaceObservation = await harness.observeDoc(WorkspaceDoc, {
		advance: (call, ctx) => {
			if (call.kind !== "value") return;
			workspaceRevision++;
			acceptWorkspace(call.value, ctx);
		},
		end: (end) => {
			if (!closing && end.kind === "failed") onError(end.error);
		},
	}, context);
	if (!workspaceObservation) throw new Error("The workspace document is unavailable.");
	if (workspaceRevision === 0) acceptWorkspace(workspaceObservation.value, context);
	const titles = new ChatTitles({ harness, models: options.models, providers, timeoutMs: options.titleTimeoutMs ?? TITLE_TIMEOUT_MS });
	await resumeFileDeletes(harness, options.files, context, onError);
	await completeAttachmentDeletes(harness, options.files, context, onError);
	await host.load(
		[
			{
				name: "oshawott.panel",
				facet: panelFacet({ harness, models: options.models, credentials: options.credentials, providers, files: options.files, now, activity, titles, onError }),
			},
		],
		context,
	);
	harness.resume();

	return {
		host,
		harness,
		acceptPanel(link, instance) {
			host.accept(link, { principal: { kind: "panel", instance }, limits: PANEL_LINK_LIMITS }, context);
		},
		async close() {
			// Links first: holders go `loading` and re-hold on the next Engine, instead of seeing their objects fail.
			closing = true;
			await host.close(context);
			titles.close();
			workspaceObservation.detach();
			activity.close();
			try {
				await harness.close(context);
			} finally {
				options.files.close?.();
			}
		},
	};
}
