import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Provider } from "@earendil-works/pi-ai";
import { sitePattern } from "../platform/patterns.ts";

/** API-key providers with a concrete HTTP endpoint. OAuth, Node-only and tenant-configured providers get separate setup flows. */
export function browserBuiltinProviders(): Provider[] {
	return builtinProviders().filter((provider) => {
		if (!provider.auth.apiKey || !provider.baseUrl || provider.baseUrl.includes("{") || provider.id === "amazon-bedrock") return false;
		if (!sitePattern(provider.baseUrl)) return false;
		return provider.getModels().every((model) => model.api !== "bedrock-converse-stream");
	});
}
