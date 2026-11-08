import { MODEL_ORIGINS } from "../manifest.ts";
import { sitePattern } from "../platform/patterns.ts";
import { ext } from "../platform/webext.ts";

/** Invoke directly inside a click handler, before awaiting anything: Firefox requires the active user gesture. */
export function requestModelAccess(baseUrl: string): Promise<boolean> {
	const pattern = sitePattern(baseUrl);
	if (!pattern) return Promise.resolve(false);
	if (MODEL_ORIGINS.includes(pattern)) return Promise.resolve(true);
	return ext.permissions.request({ origins: [pattern] });
}
