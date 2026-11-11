/** Polls `read` until it returns something other than `undefined`, `null` or `false`, and returns that. */
export async function until<T>(read: () => T | undefined | null | false, what = "the state to settle", ms = 5_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined && value !== null && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export const deferred = () => Promise.withResolvers<void>();
