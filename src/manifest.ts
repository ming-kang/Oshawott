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

/** Pin the unpacked ID so moving the build directory keeps chats, files and API keys on the same extension origin. */
export const CHROMIUM_KEY =
	"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoRB95+jYjZFX7/SFXV+nU+mQdRHP/Iam3cOn9RJKJQirf1kYWWeMC7mbMbNXvam5He0sNut4zuBepGO3F2z8Jg3w+KbQ43SrTrnBkoLXG3ABnYVPEQZuznQhFX548buYqL8QIQyBFCnNKBv7Mt098ln9I6XqbVsAAo1Pp0uc3RFPHm0JNidkJP75x/Yadb1O93/SEAVzdK+DB/viBBSlqpVISi8/FftYaH2oi1QjYcA/krL4nMcvQw+acLTrBmlU9KBl4tlxq6DVhzioDQ1GbiI/bDd+2iAtCiNubMF8tXFLxBEu7G9rI+0b3O8iEtvndJ3kjz3jp3v0Og4eP5UDMQIDAQAB";

const ICONS = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 96: "icons/icon-96.png", 128: "icons/icon-128.png" };

/** `dev`: page tools on every site without asking (automated tests cannot answer a permission prompt). */
export function manifestFor(target: Target, version: string, { dev = false } = {}): Record<string, unknown> {
	const common = {
		manifest_version: 3,
		name: "Oshawott",
		version,
		description: "A durable AI agent for your browser, built on Pi Durable.",
		icons: ICONS,
		action: { default_title: "Oshawott", default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } },
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
			key: CHROMIUM_KEY,
			minimum_chrome_version: "120",
			permissions: [...common.permissions, "offscreen", "sidePanel"],
			background: { service_worker: "background.js", type: "module" },
			side_panel: { default_path: "panel.html" },
		};
	}
	return {
		...common,
		background: { scripts: ["background.js"], type: "module" },
		sidebar_action: {
			default_panel: "panel.html",
			default_title: "Oshawott",
			default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
			open_at_install: false,
		},
		browser_specific_settings: {
			// Keep the add-on identity stable so its local data stays under one extension origin.
			gecko: { id: "oshawott@astralyn", strict_min_version: "128.0" },
		},
	};
}
