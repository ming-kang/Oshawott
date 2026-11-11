/** Runs operations one after another; a failed one does not stop the line. */
export class Serial {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(operation, operation);
		this.#tail = run.catch(() => {});
		return run;
	}
}

/** One `Serial` line per key, kept only while it has work. */
export class KeyedSerial<K> {
	readonly #lines = new Map<K, { line: Serial; waiting: number }>();

	async run<T>(key: K, operation: () => Promise<T>): Promise<T> {
		const entry = this.#lines.get(key) ?? { line: new Serial(), waiting: 0 };
		this.#lines.set(key, entry);
		entry.waiting++;
		try {
			return await entry.line.run(operation);
		} finally {
			if (--entry.waiting === 0) this.#lines.delete(key);
		}
	}
}
