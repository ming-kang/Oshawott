import { LIMITS } from "../tools/page-limits.ts";

export const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** At most `max` characters, never splitting a surrogate pair, and whether anything was cut. */
export function cut(text: string, max: number): [string, boolean] {
	if (text.length <= max) return [text, false];
	const end = /[\uD800-\uDBFF]/.test(text[max - 1] ?? "") ? max - 1 : max;
	return [text.slice(0, end), true];
}

/** Like `cut`, marking the cut with an ellipsis inside the bound. */
export function clip(text: string, max: number): [string, boolean] {
	return text.length <= max ? [text, false] : [`${cut(text, max - 1)[0]}…`, true];
}

export function take<T>(items: readonly T[], max: number): [T[], boolean] {
	return [items.slice(0, max), items.length > max];
}

/** The first `max` items that `keep` accepts, and whether another one follows; stops reading right after it. */
export function takeWhere<T>(items: Iterable<T>, keep: (item: T) => boolean, max: number): [T[], boolean] {
	const kept: T[] = [];
	for (const item of items) {
		if (!keep(item)) continue;
		if (kept.length === max) return [kept, true];
		kept.push(item);
	}
	return [kept, false];
}

/** Enough raw rows for `shapeGrid` to see a header, the row limit and that more follow. */
export const RAW_ROWS = LIMITS.rows + 2;
export const RAW_CELLS = LIMITS.columns + 1;

export interface RawRow {
	readonly header: boolean;
	readonly cells: readonly string[];
}

export interface Grid {
	headers: string[];
	rows: string[][];
	truncated: boolean;
}

/** A leading all-header row becomes `headers`; rows, columns and cells are bounded. */
export function shapeGrid(raw: readonly RawRow[]): Grid {
	let truncated = false;
	const cells = (row: RawRow) => {
		const [kept, more] = take(row.cells, LIMITS.columns);
		truncated ||= more;
		return kept.map((cell) => {
			const [text, clipped] = clip(squash(cell), LIMITS.cell);
			truncated ||= clipped;
			return text;
		});
	};
	const [first, ...rest] = raw;
	const headers = first?.header ? cells(first) : [];
	const [body, more] = take(first?.header ? rest : raw, LIMITS.rows);
	truncated ||= more;
	return { headers, rows: body.map(cells), truncated };
}
