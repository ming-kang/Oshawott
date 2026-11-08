import type { Context } from "../lib/chord.ts";
import type { PortLink } from "../link/port-link.ts";

/** Port events are not buffered, so incoming ports become links immediately and wait here for their consumers. */
export class Arrivals<K> {
	#links = new Map<K, PortLink>();
	#waiters = new Map<K, (link: PortLink) => void>();

	arrive(key: K, link: PortLink) {
		const waiter = this.#waiters.get(key);
		if (waiter) return waiter(link);
		this.#links.get(key)?.close();
		this.#links.set(key, link);
		void link.done.then(() => {
			if (this.#links.get(key) === link) this.#links.delete(key);
		});
	}

	/**
	 * The port that already arrived for `key`, or the one `summon` makes arrive within `ms`. Arrival, timeout, abort and a
	 * failed summon all settle through one path, which removes the waiter, the timer and the abort listener.
	 */
	obtain(key: K, ms: number, context: Context, summon: () => Promise<unknown>): Promise<PortLink> {
		const ready = this.#links.get(key);
		this.#links.delete(key);
		if (ready && !ready.closed) return Promise.resolve(ready);
		const signal = context.abortSignal;
		if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
		return new Promise((resolve, reject) => {
			let settled = false;
			const waiter = (link: PortLink) => settle(() => resolve(link));
			const settle = (finish: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", aborted);
				if (this.#waiters.get(key) === waiter) this.#waiters.delete(key);
				finish();
			};
			const aborted = () => settle(() => reject(signal?.reason ?? new Error("aborted")));
			const timer = setTimeout(() => settle(() => reject(new Error(`No port for ${String(key)} within ${ms} ms`))), ms);
			signal?.addEventListener("abort", aborted, { once: true });
			this.#waiters.set(key, waiter);
			Promise.resolve().then(summon).catch((error: unknown) => settle(() => reject(error)));
		});
	}
}
