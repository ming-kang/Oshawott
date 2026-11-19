export type ErrorKind = "auth" | "rate_limit" | "overloaded" | "server" | "bad_request" | "network" | "timeout" | "unknown";

export type ErrorDescription = {
	status?: number;
	kind: ErrorKind;
	/** The provider's own message when one can be found, otherwise the raw text. */
	summary: string;
};

const STATUS_KIND: Record<number, ErrorKind> = {
	400: "bad_request", 401: "auth", 403: "auth", 404: "bad_request", 422: "bad_request", 429: "rate_limit", 529: "overloaded",
};

const TYPE_KIND: Record<string, ErrorKind> = {
	authentication_error: "auth", invalid_api_key: "auth", permission_denied: "auth", permission_error: "auth",
	rate_limit_error: "rate_limit", insufficient_quota: "rate_limit",
	overloaded_error: "overloaded", overloaded: "overloaded",
	invalid_request_error: "bad_request", not_found_error: "bad_request",
	server_error: "server", api_error: "server", internal_error: "server", internal_server_error: "server",
};

const NETWORK = /failed to fetch|fetch failed|network.?error|econn\w*|enetunreach|enotfound|socket hang up|connection (?:refused|reset|closed|aborted)/i;
const TIMEOUT = /timed? ?out|timeout|deadline exceeded/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const code = (value: unknown): number | undefined => typeof value === "number" && value >= 100 && value <= 599 ? value : undefined;

/** Read an HTTP status and human summary out of the shapes model providers put in `errorMessage`. */
export function describeError(raw: string): ErrorDescription {
	const trimmed = raw.trim();
	const match = /^(\d{3})\s*:?\s*([\s\S]*)$/.exec(trimmed);
	let status = match ? Number(match[1]) : undefined;
	const body = (match?.[2] ?? trimmed).trim();
	let summary = body || trimmed;
	let kind: ErrorKind | undefined;
	if (body.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(body);
			if (isRecord(parsed)) {
				const error = parsed.error;
				summary = text(parsed.message) ?? (isRecord(error) ? text(error.message) : undefined)
					?? text(error) ?? text(parsed.detail) ?? summary;
				const type = (isRecord(error) ? text(error.type) : undefined) ?? text(parsed.type);
				if (type) kind = TYPE_KIND[type];
				status ??= code(parsed.status) ?? (isRecord(error) ? code(error.status) : undefined);
			}
		} catch {
		}
	}
	if (status !== undefined) kind = STATUS_KIND[status] ?? (status >= 500 && status <= 599 ? "server" : kind);
	if (kind === undefined || kind === "server") {
		if (/overloaded/i.test(summary)) kind = "overloaded";
	}
	kind ??= TIMEOUT.test(summary) ? "timeout" : NETWORK.test(summary) ? "network" : "unknown";
	return { status, kind, summary };
}
