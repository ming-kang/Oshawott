import type { CredentialStore, MutableModels } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { ChordError } from "../lib/chord.ts";
import type { KeyedSerial } from "../lib/serial.ts";
import type { ConversationActivity } from "./activity.ts";
import type { Approvals } from "./approvals.ts";
import type { FileBackend } from "./files.ts";
import type { LoginSessions } from "./oauth.ts";
import type { ProviderAdmin } from "./provider-admin.ts";
import type { ProviderManager } from "./providers.ts";
import type { ChatTitles } from "./titles.ts";

export interface EngineServices {
	readonly harness: Harness;
	readonly models: MutableModels;
	readonly credentials: CredentialStore;
	readonly providers: ProviderManager;
	readonly admin: ProviderAdmin;
	readonly logins: LoginSessions;
	readonly approvals: Approvals;
	readonly files: FileBackend;
	readonly now: () => number;
	readonly activity: ConversationActivity;
	readonly titles: ChatTitles;
	readonly onError: (error: unknown) => void;
}

/** What the two objects share: one Engine owns a profile, so a chat's admissions, edits and renames run one at a time. */
export interface FacetServices extends EngineServices {
	readonly chatLine: KeyedSerial<number>;
}

export function forbidden(): never {
	throw new ChordError({ code: "forbidden", message: "Only a panel may use the workspace." });
}

export const gone = (id: number) => new ChordError({ code: "gone", message: `No chat ${id}` });
