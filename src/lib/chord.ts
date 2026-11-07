export * from "@earendil-works/chord/next";
export { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";

import type { Schema } from "@earendil-works/chord/next";

/** Compile-time only: the schema does not validate `T`. */
export function typed<T>(schema: Schema<unknown>): Schema<T> {
	return schema as Schema<T>;
}
