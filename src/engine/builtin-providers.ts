import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Provider } from "@earendil-works/pi-ai";
import { sitePattern } from "../platform/patterns.ts";
import type { OAuthSetups } from "./oauth.ts";

/**
 * The Pi-AI sign-ins that need no loopback callback server. Every other OAuth flow (Sign in with ChatGPT, OpenRouter,
 * Radius, Anthropic's browser callback) is left out; `scripts/lib/pi-ai.mjs` bundles exactly these flows.
 */
export const BROWSER_OAUTH: OAuthSetups = {
	anthropic: { origins: ["https://platform.claude.com/*", "https://api.anthropic.com/*"], select: "copy_code" },
	"openai-codex": { origins: ["https://auth.openai.com/*", "https://chatgpt.com/*"], select: "device_code" },
	// github.com only: an Enterprise domain would need its own host permission.
	"github-copilot": { origins: ["https://github.com/*", "https://api.github.com/*", "https://*.githubcopilot.com/*"], text: "" },
	"kimi-coding": { origins: ["https://auth.kimi.com/*", "https://api.kimi.com/*"] },
	meta: { origins: ["https://auth.meta.com/*", "https://api.meta.ai/*"] },
	xai: { origins: ["https://auth.x.ai/*", "https://api.x.ai/*"] },
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
		if (!provider.baseUrl || provider.baseUrl.includes("{") || provider.id === "amazon-bedrock" || !sitePattern(provider.baseUrl)) return [];
		if (provider.getModels().some((model) => model.api === "bedrock-converse-stream")) return [];
		const { apiKey } = provider.auth;
		const oauth = BROWSER_OAUTH[provider.id] ? provider.auth.oauth : undefined;
		if (!apiKey && !oauth) return [];
		const browser = { ...provider, auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) } };
		return [oauth ? overSse(browser) : browser];
	});
}
