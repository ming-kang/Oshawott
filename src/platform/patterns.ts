// Firefox match patterns do not support ports; Chromium patterns without one cover every port.
export function sitePattern(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return `${parsed.protocol}//${parsed.hostname}/*`;
	} catch {
		return undefined;
	}
}

export function hostOf(url: unknown): string {
	const raw = String(url ?? "");
	return URL.canParse(raw) ? new URL(raw).host : raw;
}
