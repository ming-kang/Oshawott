export type Target = "chromium" | "firefox";

declare global {
	/** A bare build-time identifier lets non-dev bundles eliminate dev-only branches. */
	const __OSHAWOTT_DEV__: boolean;
}
