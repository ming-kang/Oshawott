import { MESSAGES } from "../contracts/hosts.ts";
import { runEngine } from "../engine/browser.ts";
import { ext } from "../platform/webext.ts";

void runEngine({
	broker: (context, brokers) => brokers.obtain("broker", 10_000, context, () => ext.runtime.sendMessage({ type: MESSAGES.wakeBroker })),
});
