export function isHttpUrl(url: unknown): boolean {
	try {
		const { protocol } = new URL(String(url ?? ""));
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export function hostOf(url: unknown): string {
	const raw = String(url ?? "");
	return URL.canParse(raw) ? new URL(raw).host : raw;
}
