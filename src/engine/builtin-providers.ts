import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Provider } from "@earendil-works/pi-ai";
import { isHttpUrl } from "../platform/patterns.ts";
import type { OAuthSetups } from "./oauth.ts";

/**
 * The Pi-AI sign-ins that need no loopback callback server. Every other OAuth flow (Sign in with ChatGPT, OpenRouter,
 * Radius, Anthropic's browser callback) is left out; `scripts/lib/pi-ai.mjs` bundles exactly these flows.
 */
export const BROWSER_OAUTH: OAuthSetups = {
	anthropic: { select: "copy_code" },
	"openai-codex": { select: "device_code" },
	"github-copilot": { text: "" },
	"kimi-coding": {},
	meta: {},
	xai: {},
};

/** A browser WebSocket cannot carry the providers' authorization headers. */
function overSse(provider: Provider): Provider {
	const { stream, streamSimple } = provider;
	return {
		...provider,
		stream: (model, context, options) => stream(model, context, { ...options, transport: "sse" } as typeof options),
		streamSimple: (model, context, options) => streamSimple(model, context, { ...options, transport: "sse" }),
	};
}

/**
 * Providers with a concrete HTTP endpoint and at least one auth method a browser can use: an API key, or one of the
 * `BROWSER_OAUTH` sign-ins. Node-only and tenant-configured providers get separate setup flows.
 */
export function browserBuiltinProviders(): Provider[] {
	return builtinProviders().flatMap((provider) => {
		if (!provider.baseUrl || provider.baseUrl.includes("{") || provider.id === "amazon-bedrock" || !isHttpUrl(provider.baseUrl)) return [];
		if (provider.getModels().some((model) => model.api === "bedrock-converse-stream")) return [];
		const { apiKey } = provider.auth;
		const oauth = BROWSER_OAUTH[provider.id] ? provider.auth.oauth : undefined;
		if (!apiKey && !oauth) return [];
		const browser = { ...provider, auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) } };
		return [oauth ? overSse(browser) : browser];
	});
}
