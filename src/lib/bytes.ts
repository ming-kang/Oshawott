/** A file size in binary units, shared by the panel's file list and tool summaries. */
export function formatBytes(bytes: number): string {
	const units = ["B", "KiB", "MiB", "GiB"];
	let unit = 0;
	let value = bytes;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${Number(value.toFixed(1))} ${units[unit]}`;
}
