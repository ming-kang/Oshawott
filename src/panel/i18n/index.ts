import { en, type Key } from "./en.ts";
import { zh } from "./zh-CN.ts";

export type Language = "zh-CN" | "en";
export type LanguagePreference = Language | "system";
const LANGUAGE_KEY = "oshawott:language";

export function savedLanguagePreference(): LanguagePreference {
	if (typeof window === "undefined") return "system";
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
	return (globalThis.navigator?.language || "en").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function saveLanguage(preference: LanguagePreference) {
	if (preference === "system") localStorage.removeItem(LANGUAGE_KEY);
	else localStorage.setItem(LANGUAGE_KEY, preference);
}

let current: Language | undefined;
export const language = (): Language => current ??= savedLanguage();

export function t(key: Key, ...args: (string | number)[]): string {
	const table = language() === "zh-CN" ? zh : en;
	return table[key].replace(/\{(\d)\}/g, (_, i: string) => String(args[Number(i)] ?? ""));
}
