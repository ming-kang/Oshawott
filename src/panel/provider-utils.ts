import type { ModelApi, ModelConfig, ProviderSummary } from "../contracts/chat.ts";
import { compactTokens } from "./models.ts";
import { t } from "./i18n/index.ts";

export const WELL_KNOWN = ["anthropic", "openai", "google", "openrouter", "deepseek", "xai", "github-copilot", "openai-codex", "mistral", "groq"];
export const providerRank = (provider: ProviderSummary) => {
	const at = WELL_KNOWN.indexOf(provider.id);
	return at < 0 ? WELL_KNOWN.length : at;
};
export const defaultModel = (): ModelConfig => ({
	id: "", name: "", contextWindow: 128_000, maxTokens: 16_384, vision: false, thinkingLevels: ["off"],
});
const REQUEST_PATHS: Readonly<Record<ModelApi, string>> = {
	"anthropic-messages": "/v1/messages", "openai-responses": "/responses", "openai-completions": "/chat/completions",
};
export const baseUrlPlaceholder = (api: ModelApi) => api === "anthropic-messages" ? "https://api.example.com" : "https://api.example.com/v1";
export function validEndpointUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		if (url.username || url.password || url.search || url.hash) return undefined;
		return url.href.replace(/\/+$/, "");
	} catch { return undefined; }
}
export function connectionNote(api: ModelApi, rawUrl: string): { text: string; warning: boolean } | undefined {
	const base = validEndpointUrl(rawUrl);
	if (!base) return undefined;
	const target = `${base}${REQUEST_PATHS[api]}`;
	const doubled = api === "anthropic-messages" && /\/v1$/i.test(base);
	return { text: t(doubled ? "settings.endpointDoubleV1" : "settings.endpointHint", target), warning: doubled };
}
export function modelCapabilitiesText(model: Pick<ModelConfig, "contextWindow" | "maxTokens" | "vision" | "thinkingLevels">, includeMaxTokens = false) {
	const hasThinking = model.thinkingLevels.some((level) => level !== "off");
	return [compactTokens(model.contextWindow), includeMaxTokens ? `${compactTokens(model.maxTokens)} out` : "", model.vision ? t("settings.vision") : "", hasThinking ? t("settings.thinking") : ""]
		.filter(Boolean).join(" · ");
}
