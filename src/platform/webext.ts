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
	readonly status?: string;
	readonly favIconUrl?: string;
	readonly lastAccessed?: number;
}

export interface WebExt {
	readonly permissions: {
		contains(permissions: { origins: string[] }): Promise<boolean>;
		request(permissions: { origins: string[] }): Promise<boolean>;
		readonly onAdded: WebExtEvent<(permissions: { origins?: string[]; permissions?: string[] }) => void>;
		readonly onRemoved: WebExtEvent<(permissions: { origins?: string[]; permissions?: string[] }) => void>;
	};
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
		get(tabId: number): Promise<TabInfo>;
		create(properties: { url: string; active?: boolean }): Promise<TabInfo>;
		goBack(tabId: number): Promise<void>;
		goForward(tabId: number): Promise<void>;
		reload(tabId: number, properties?: { bypassCache?: boolean }): Promise<void>;
		update(tabId: number, properties: { url?: string; active?: boolean }): Promise<TabInfo>;
		remove(tabId: number): Promise<void>;
		captureVisibleTab?(windowId: number, options: { format?: string; quality?: number }): Promise<string>;
		/** Tab groups; absent where the browser does not have them. */
		group?(options: { groupId?: number; tabIds: number | number[]; createProperties?: { windowId?: number } }): Promise<number>;
		readonly onRemoved: WebExtEvent<(tabId: number) => void>;
		readonly onActivated: WebExtEvent<(info: { tabId: number; windowId: number }) => void>;
		readonly onUpdated: WebExtEvent<(tabId: number, change: { status?: string }, tab: TabInfo) => void>;
	};
	/** Tab group metadata; absent where `tabs.group` is. */
	readonly tabGroups?: {
		update(groupId: number, properties: { title?: string; color?: string }): Promise<unknown>;
	};
	readonly storage?: {
		/** In-memory per browser session: survives extension restarts, not browser restarts. */
		readonly session: {
			get(keys: string): Promise<Record<string, unknown>>;
			set(items: Record<string, unknown>): Promise<void>;
		};
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
