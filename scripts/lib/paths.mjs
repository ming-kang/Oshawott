import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(fileURLToPath(import.meta.url), "..", "..", "..");

export const dist = (...parts) => join(root, "dist", ...parts);

export async function freshDir(...parts) {
	const dir = dist(...parts);
	await rm(dir, { recursive: true, force: true });
	await mkdir(dir, { recursive: true });
	return dir;
}
