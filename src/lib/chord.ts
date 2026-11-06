// Chord, through one module. Oshawatt is written against Chord's v2 API, which 1.5.0 publishes as
// `@earendil-works/chord/next` and the next release moves to the package root. Switching is this one line.
export * from "@earendil-works/chord/next";
export { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";

import type { Schema } from "@earendil-works/chord/next";

/** A JSON value whose shape the contract does not check (a Durable view): typed for TypeScript only. */
export function typed<T>(schema: Schema<unknown>): Schema<T> {
	return schema as Schema<T>;
}
