export interface WebExtEvent<L extends (...args: never[]) => unknown> {
	addListener(listener: L): void;
	removeListener(listener: L): void;
}

export interface MessageSender {
	readonly id?: string;
	readonly url?: string;
	readonly tab?: TabInfo;
	readonly frameId?: number;
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
	readonly favIconUrl?: string;
	/** Milliseconds since the epoch. */
	readonly lastAccessed?: number;
}

export interface WebExt {
	readonly runtime: {
		readonly id: string;
		readonly lastError?: { readonly message?: string };
		getURL(path: string): string;
		getManifest(): { readonly version: string; readonly manifest_version: number; readonly name: string };
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
		create(properties: { url: string; active?: boolean }): Promise<TabInfo>;
		update(tabId: number, properties: { url?: string; active?: boolean }): Promise<TabInfo>;
		remove(tabId: number): Promise<void>;
		readonly onRemoved: WebExtEvent<(tabId: number) => void>;
		readonly onActivated: WebExtEvent<(info: { tabId: number; windowId: number }) => void>;
		readonly onUpdated: WebExtEvent<(tabId: number, change: { status?: string }, tab: TabInfo) => void>;
	};
	readonly scripting: {
		executeScript(injection: {
			target: { tabId: number };
			files?: string[];
			func?: (...args: never[]) => unknown;
			args?: unknown[];
		}): Promise<unknown>;
	};
	readonly alarms: {
		create(name: string, info: { when: number }): Promise<void> | void;
		clear(name: string): Promise<boolean>;
		readonly onAlarm: WebExtEvent<(alarm: { readonly name: string }) => void>;
	};
	readonly permissions: {
		contains(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
		request(permissions: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
		readonly onAdded: WebExtEvent<(permissions: { origins?: string[] }) => void>;
		readonly onRemoved: WebExtEvent<(permissions: { origins?: string[] }) => void>;
	};
	readonly action: {
		readonly onClicked: WebExtEvent<(tab: TabInfo) => void>;
	};
	/** Chromium only. */
	readonly offscreen?: {
		createDocument(parameters: { url: string; reasons: string[]; justification: string }): Promise<void>;
	};
	/** Chromium only. */
	readonly sidePanel?: {
		setPanelBehavior(behavior: { openPanelOnActionClick: boolean }): Promise<void>;
	};
	/** Firefox only. */
	readonly sidebarAction?: {
		open(): Promise<void>;
		toggle?(): Promise<void>;
	};
}

const scope = globalThis as unknown as { browser?: WebExt; chrome?: WebExt };

export const ext: WebExt = (scope.browser ?? scope.chrome) as WebExt;
