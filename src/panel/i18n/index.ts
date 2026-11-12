import { en, type Key } from "./en.ts";
import { zh } from "./zh-CN.ts";

export type Language = "zh-CN" | "en";
export type LanguagePreference = Language | "system";
const LANGUAGE_KEY = "oshawott:language";

export function savedLanguagePreference(): LanguagePreference {
	try {
		const stored = localStorage.getItem(LANGUAGE_KEY);
		if (stored === "zh-CN" || stored === "en") return stored;
	} catch {
	}
	return "system";
}

export function savedLanguage(): Language {
	const preference = savedLanguagePreference();
	if (preference !== "system") return preference;
	return (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function saveLanguage(preference: LanguagePreference) {
	if (preference === "system") localStorage.removeItem(LANGUAGE_KEY);
	else localStorage.setItem(LANGUAGE_KEY, preference);
}

const table: Record<Key, string> = savedLanguage() === "zh-CN" ? zh : en;

export const LANG: Language = table === zh ? "zh-CN" : "en";

export function t(key: Key, ...args: (string | number)[]): string {
	return table[key].replace(/\{(\d)\}/g, (_, i: string) => String(args[Number(i)] ?? ""));
}
