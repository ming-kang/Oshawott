import { PANEL_LINK_LIMITS } from "../contracts/chat.ts";
import { MESSAGES, PORTS, type Principal } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost } from "../lib/chord.ts";
import { portLink } from "../link/port-link.ts";
import { ext } from "../platform/webext.ts";

export type PanelHost = ReturnType<typeof createPanelHost>;

export const createPanelHost = () => createHost<Principal>({ onError: (error) => console.debug("[oshawott panel]", error) });

export function engineConnector(host: PanelHost, changed: (reconnecting: boolean) => void) {
	let backoff = 250;
	return async function connect() {
		try {
			await ext.runtime.sendMessage({ type: MESSAGES.ensureEngine });
		} catch {
		}
		const link = portLink(ext.runtime.connect({ name: PORTS.panel }), () => ext.runtime.lastError?.message);
		host.connect(link, { principal: { kind: "engine" }, limits: PANEL_LINK_LIMITS }, BACKGROUND_CONTEXT);
		const healthy = setTimeout(() => {
			backoff = 250;
			changed(false);
		}, 1500);
		void link.done.then(() => {
			clearTimeout(healthy);
			changed(true);
			setTimeout(() => void connect(), backoff);
			backoff = Math.min(backoff * 2, 10_000);
		});
	};
}
