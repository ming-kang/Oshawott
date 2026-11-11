// The hosts around an Engine, offline: a Broker serving a fake browser, page hosts, links and connected panels.
// A test sets up only what it exercises and overrides the rest.
import { createModels, type fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Browser } from "../../src/contracts/browser.ts";
import { Chat, Workspace } from "../../src/contracts/chat.ts";
import { BrokerHost, type Principal, TabHost } from "../../src/contracts/hosts.ts";
import { Page } from "../../src/contracts/page.ts";
import { type Engine, type EngineOptions, startEngine } from "../../src/engine/engine.ts";
import { MemoryFileBackend } from "../../src/engine/files.ts";
import {
	BACKGROUND_CONTEXT, createHost, defineFacet, type Host, type Implementation, type Link, memoryLinkPair, type Reference,
} from "../../src/lib/chord.ts";
import { portLink } from "../../src/link/port-link.ts";
import { fakePortPair } from "./fake-port.ts";

export const context = BACKGROUND_CONTEXT;
export const ignore = () => {};

type OnError = (error: unknown) => void;
export type BrowserMembers = Implementation<typeof Browser>["members"];
export type PageMembers = Implementation<typeof Page>["members"];
export type WorkspaceRef = Extract<Reference<typeof Workspace>, { variant: "owner" }>;
export type ChatRef = Extract<Reference<typeof Chat>, { variant: "owner" }>;

const unused = async (): Promise<never> => {
	throw new Error("unused");
};

/** A browser with no tabs and no site access; `overrides` supply what a test exercises. */
export function fakeBrowser(overrides: Partial<BrowserMembers> = {}): BrowserMembers {
	return {
		listTabs: async () => [], activeTab: async () => null, getTab: async () => null,
		openTab: unused, navigateTab: unused, activateTab: unused, closeTab: async () => null,
		attach: async () => null, hasAccess: async () => false, armWake: async () => null,
		...overrides,
	};
}

/** A Broker host serving `members` as the Engine's `Browser`. */
export async function serveBrowser(members = fakeBrowser(), onError: OnError = ignore): Promise<Host<Principal>> {
	const broker = createHost<Principal>({ address: BrokerHost(), principal: { kind: "broker" }, onError });
	await broker.load([{ name: "broker", facet: defineFacet<Principal>((host) => {
		host.serve(Browser, () => ({ variant: "engine", members }));
	}) }], context);
	return broker;
}

/** A page host of `tabId` serving `members` as the Engine's `Page`. */
export async function servePage(tabId: number, members: PageMembers, onError: OnError = ignore): Promise<Host<Principal>> {
	const page = createHost<Principal>({ address: TabHost({ tabId }), principal: { kind: "tab", tabId }, onError });
	await page.load([{ name: "page", facet: defineFacet<Principal>((host) => {
		host.serve(Page, () => ({ variant: "engine", members }));
	}) }], context);
	return page;
}

/** Two connected link ends; `portPair` runs them through `portLink` over fake `runtime.Port`s, as in the browsers. */
export type LinkPair = () => [Link, Link];
export const portPair: LinkPair = () => {
	const [a, b] = fakePortPair();
	return [portLink(a), portLink(b)];
};

/** The Engine's end of a new link to `host`, which accepts the other end as the Engine. */
export function linkTo(host: Host<Principal>, pair: LinkPair = memoryLinkPair): Link {
	const [engineEnd, otherEnd] = pair();
	host.accept(otherEnd, { principal: { kind: "engine" } }, context);
	return engineEnd;
}

/** A memory storage whose `close` keeps its data, as IndexedDB outlives the Engine that had it open. */
export function persistentStorage(): MemoryStorage {
	return new Proxy(new MemoryStorage(), {
		get(target, key) {
			if (key === "close") return async () => {};
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * An Engine linked to `broker`, on memory storage, files and credentials unless `options` give them. It has no tab
 * route unless `options.tab` gives one; `pair` makes its links to the Broker.
 */
export function openEngine(broker: Host<Principal>, options: Partial<EngineOptions> & { pair?: LinkPair } = {}): Promise<Engine> {
	const { pair, ...given } = options;
	const credentials = given.credentials ?? new InMemoryCredentialStore();
	return startEngine({
		...given,
		credentials,
		storage: given.storage ?? new MemoryStorage(),
		models: given.models ?? createModels({ credentials }),
		files: given.files ?? new MemoryFileBackend(),
		onError: given.onError ?? ignore,
		broker: given.broker ?? (async () => linkTo(broker, pair)),
		tab: given.tab ?? (async () => { throw new Error("no tabs here"); }),
	}, context);
}

export interface Panel {
	readonly host: Host<Principal>;
	readonly workspace: WorkspaceRef;
	/** Opens chat `id`; `close` releases it. */
	chat(id: number): Promise<ChatRef>;
	close(): Promise<void>;
}

/** A panel connected to `engine`, holding its Workspace. */
export async function connectPanel(engine: Engine, options: { pair?: LinkPair; onError?: OnError } = {}): Promise<Panel> {
	const host = createHost<Principal>({ onError: options.onError ?? ignore });
	const [panelEnd, engineEnd] = (options.pair ?? memoryLinkPair)();
	engine.acceptPanel(engineEnd, crypto.randomUUID());
	host.connect(panelEnd, { principal: { kind: "engine" } }, context);
	await host.load([], context);
	const workspace = await host.get(Workspace, {}, context);
	if (workspace.variant !== "owner") throw new Error("The Engine did not give the panel its Workspace");
	const chats = new Set<ChatRef>();
	return {
		host, workspace,
		async chat(id) {
			const chat = await host.get(Chat, { id }, context);
			if (chat.variant !== "owner") throw new Error(`The Engine did not give the panel chat ${id}`);
			chats.add(chat);
			return chat;
		},
		async close() {
			for (const chat of chats) chat.release();
			workspace.release();
			await host.close(context);
		},
	};
}

/** Makes `faux`'s model the default for new chats. */
export async function useModel(workspace: WorkspaceRef, faux: ReturnType<typeof fauxProvider>): Promise<void> {
	const model = faux.getModel();
	await workspace.setDefaultConfiguration({ model: { provider: model.provider, modelId: model.id } }, context);
}
