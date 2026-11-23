export function isHttpUrl(url: unknown): boolean {
	try {
		const { protocol } = new URL(String(url ?? ""));
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

export function isFileUrl(url: unknown): boolean {
	try {
		return new URL(String(url ?? "")).protocol === "file:";
	} catch {
		return false;
	}
}

export function hostOf(url: unknown): string {
	const raw = String(url ?? "");
	return URL.canParse(raw) ? new URL(raw).host : raw;
}
