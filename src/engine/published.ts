import type { Observation, Observer } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context } from "../lib/chord.ts";

/**
 * A value the Engine owns and every Panel follows: one copy, so two open panels can never disagree. `observe` has the
 * shape of a Durable observation, which is what `self.follow` takes.
 */
export class Published<T> {
	readonly #observers = new Set<Observer<T>>();
	#value: T;
	#closed = false;

	constructor(initial: T) {
		this.#value = initial;
	}

	get value(): T {
		return this.#value;
	}

	observe(observer: Observer<T>): Promise<Observation<T>> {
		this.#observers.add(observer);
		return Promise.resolve({ value: this.#value, detach: () => { this.#observers.delete(observer); } });
	}

	set(value: T, context: Context = BACKGROUND_CONTEXT) {
		if (this.#closed) return;
		this.#value = value;
		for (const observer of this.#observers) observer.advance({ kind: "value", value, ops: [["r", value as never]], retired: false }, context);
	}

	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const observer of this.#observers) observer.end({ kind: "ended" });
		this.#observers.clear();
	}
}
