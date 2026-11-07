export type Target = "chromium" | "firefox";

declare const __OSHAWOTT_TARGET__: Target | undefined;

declare global {
	/** A bare build-time identifier lets non-dev bundles eliminate dev-only branches. */
	const __OSHAWOTT_DEV__: boolean;
}

// Tests run without the build-time define and use Chromium.
export const TARGET: Target = typeof __OSHAWOTT_TARGET__ === "undefined" ? "chromium" : __OSHAWOTT_TARGET__;

export const PLACEMENT = {
	chromium: { engineWithBroker: false },
	firefox: { engineWithBroker: true },
} as const satisfies Record<Target, { engineWithBroker: boolean }>;
