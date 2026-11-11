import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(fileURLToPath(import.meta.url), "..", "..", "..");

/** A path under `dist/`, where builds and everything the scripts produce go. */
export const dist = (...parts) => join(root, "dist", ...parts);

/** Empties `dist/<parts>` for a run's output, and returns its path. */
export async function freshDir(...parts) {
	const dir = dist(...parts);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	return dir;
}
