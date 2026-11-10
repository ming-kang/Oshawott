import { MODEL_ORIGINS } from "../manifest.ts";
import { sitePattern } from "../platform/patterns.ts";
import { ext } from "../platform/webext.ts";

/** Invoke directly inside a click handler, before awaiting anything: Firefox requires the active user gesture. */
export function requestModelAccess(baseUrl: string): Promise<boolean> {
	const pattern = sitePattern(baseUrl);
	if (!pattern) return Promise.resolve(false);
	return requestOrigins([pattern]);
}

/** As above, for match patterns: only those the manifest does not already grant are asked for. */
export function requestOrigins(origins: readonly string[]): Promise<boolean> {
	const missing = origins.filter((origin) => !MODEL_ORIGINS.includes(origin));
	return missing.length ? ext.permissions.request({ origins: missing }) : Promise.resolve(true);
}
