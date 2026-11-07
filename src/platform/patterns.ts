// The host permission that covers a URL's site: its scheme and host name, every path. Without the port, which Firefox
// does not support in match patterns (a pattern with one matches nothing there); Chromium matches every port of a host
// whose pattern has none. Only http(s) URLs have one.
export function sitePattern(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
		return `${parsed.protocol}//${parsed.hostname}/*`;
	} catch {
		return undefined;
	}
}
