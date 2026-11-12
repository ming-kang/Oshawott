import type { Principal } from "../contracts/hosts.ts";
import { defineFacet } from "../lib/chord.ts";
import { KeyedSerial } from "../lib/serial.ts";
import { serveChat } from "./chat-facet.ts";
import type { EngineServices, FacetServices } from "./facet-services.ts";
import { serveWorkspace } from "./workspace-facet.ts";

/** Everything a Panel may hold: the `Workspace` and one `Chat` per conversation. */
export function panelFacet(services: EngineServices) {
	const shared: FacetServices = { ...services, chatLine: new KeyedSerial() };
	return defineFacet<Principal>((host) => {
		serveWorkspace(host, shared);
		serveChat(host, shared);
	});
}
