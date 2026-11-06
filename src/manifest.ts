// One manifest per target, from one description. What differs is only where things run and which keys each browser
// reads; the permissions are the same, and none is broader than a feature needs.
import type { Target } from "./platform/target.ts";

/** Model APIs the Engine calls from its document; host permissions let those requests skip CORS. */
export const MODEL_ORIGINS = [
	"https://api.anthropic.com/*",
	"https://api.openai.com/*",
	"https://generativelanguage.googleapis.com/*",
	"https://openrouter.ai/*",
	"https://api.deepseek.com/*",
];

/** `dev`: page tools on every site without asking (automated tests cannot answer a permission prompt). */
export function manifestFor(target: Target, version: string, { dev = false } = {}): Record<string, unknown> {
	const common = {
		manifest_version: 3,
		name: "Oshawatt",
		version,
		description: "A durable AI agent for your browser, built on Pi Durable.",
		action: { default_title: "Oshawatt" },
		// `tabs` for titles and URLs in tabs_list; `scripting` + `activeTab` / granted origins to inject page tools on
		// demand (nothing is declared for every site); `alarms` for the Engine's wakeups.
		permissions: ["tabs", "scripting", "activeTab", "alarms"],
		host_permissions: dev ? [...MODEL_ORIGINS, "<all_urls>"] : MODEL_ORIGINS,
		// Page tools on any site the user grants; requested at runtime, never at install.
		optional_host_permissions: ["<all_urls>"],
		// QuickJS (code mode) is WebAssembly.
		content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
	};

	if (target === "chromium") {
		return {
			...common,
			minimum_chrome_version: "120",
			permissions: [...common.permissions, "offscreen", "sidePanel"],
			background: { service_worker: "background.js", type: "module" },
			side_panel: { default_path: "panel.html" },
		};
	}
	return {
		...common,
		background: { scripts: ["background.js"], type: "module" },
		sidebar_action: { default_panel: "panel.html", default_title: "Oshawatt", open_at_install: false },
		browser_specific_settings: {
			// Replace with the add-on's AMO id before signing.
			gecko: { id: "oshawatt@example.org", strict_min_version: "128.0" },
		},
	};
}
