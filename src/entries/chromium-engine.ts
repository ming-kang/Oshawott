import { MESSAGES } from "../contracts/hosts.ts";
import { runEngine } from "../engine/browser.ts";
import { ext } from "../platform/webext.ts";

void runEngine({
	broker: async (context, brokers) => {
		const ready = brokers.take("broker");
		if (ready && !ready.closed) return ready;
		const arriving = brokers.wait("broker", 10_000, context);
		await ext.runtime.sendMessage({ type: MESSAGES.wakeBroker });
		return await arriving;
	},
});
