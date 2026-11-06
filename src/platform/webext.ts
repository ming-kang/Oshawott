// The one place that touches the WebExtension API. Everything else imports the typed subset below, so the surface
// Oshawatt depends on is explicit, and the Chromium/Firefox differences are written down once.
//
// Both browsers expose a promise-based `chrome.*` in Manifest V3 (Firefox also as `browser.*`). Only the members used
// here are typed; a missing optional namespace (`offscreen`, `sidePanel`, `sidebarAction`, `userScripts`) is
// `undefined`, never an empty object.

export interface WebExtEvent<L extends (...args: never[]) => unknown> {
	addListener(listener: L): void;
	removeListener(listener: L): void;
}

export interface MessageSender {
	readonly id?: string;
	readonly url?: string;
	readonly tab?: TabInfo;
	readonly frameId?: number;
	/** Chromium 106+, Firefox 128+. */
	readonly documentId?: string;
}

export interface RuntimePort {
	readonly name: string;
	readonly sender?: MessageSender;
	/** Firefox sets it before `onDisconnect`; Chromium uses `runtime.lastError` instead. */
	readonly error?: { readonly message: string } | null;
	postMessage(message: unknown): void;
	disconnect(): void;
	readonly onMessage: WebExtEvent<(message: unknown, port: RuntimePort) => void>;
	readonly onDisconnect: WebExtEvent<(port: RuntimePort) => void>;
}

export interface TabInfo {
	readonly id?: number;
	readonly windowId?: number;
	readonly url?: string;
	readonly title?: string;
	readonly active?: boolean;
	readonly status?: string;
}

export interface InjectionResult {
	readonly frameId: number;
	readonly documentId?: string;
	readonly result?: unknown;
	readonly error?: unknown;
}

export interface WebExt {
	readonly runtime: {
		readonly id: string;
		readonly lastError?: { readonly message?: string };
		getURL(path: string): string;
		getManifest(): { readonly version: string; readonly manifest_version: number };
		connect(info: { name: string }): RuntimePort;
		sendMessage(message: unknown): Promise<unknown>;
		getContexts?(filter: { contextTypes: string[]; documentUrls?: string[] }): Promise<readonly unknown[]>;
		readonly onConnect: WebExtEvent<(port: RuntimePort) => void>;
		readonly onMessage: WebExtEvent<
			(message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | undefined | Promise<unknown>
		>;
		readonly onStartup: WebExtEvent<() => void>;
		readonly onInstalled: WebExtEvent<(details: { reason: string }) => void>;
	};
	readonly tabs: {
		query(query: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean; windowId?: number }): Promise<TabInfo[]>;
		get(tabId: number): Promise<TabInfo>;
		create(properties: { url: string; active?: boolean; windowId?: number }): Promise<TabInfo>;
		readonly onRemoved: WebExtEvent<(tabId: number) => void>;
	};
	readonly scripting: {
		executeScript(injection: {
			target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
			files?: string[];
			func?: (...args: never[]) => unknown;
			args?: unknown[];
			world?: "ISOLATED" | "MAIN";
			injectImmediately?: boolean;
		}): Promise<InjectionResult[]>;
	};
	readonly alarms: {
		create(name: string, info: { when?: number; delayInMinutes?: number; periodInMinutes?: number }): Promise<void> | void;
		clear(name: string): Promise<boolean>;
		readonly onAlarm: WebExtEvent<(alarm: { readonly name: string; readonly scheduledTime: number }) => void>;
	};
	readonly permissions: {
		contains(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
		request(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
	};
	readonly action: {
		readonly onClicked: WebExtEvent<(tab: TabInfo) => void>;
		setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
	};
	/** Chromium only. */
	readonly offscreen?: {
		createDocument(parameters: { url: string; reasons: string[]; justification: string }): Promise<void>;
		closeDocument(): Promise<void>;
		hasDocument?(): Promise<boolean>;
	};
	/** Chromium only. */
	readonly sidePanel?: {
		open(options: { windowId?: number; tabId?: number }): Promise<void>;
		setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
	};
	/** Firefox only. */
	readonly sidebarAction?: {
		open(): Promise<void>;
		toggle?(): Promise<void>;
	};
}

const scope = globalThis as unknown as { browser?: WebExt; chrome?: WebExt };

/** The extension API of this context: `browser` where it exists (Firefox), else `chrome`. */
export const ext: WebExt = (scope.browser ?? scope.chrome) as WebExt;
