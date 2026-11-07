// The build target, fixed at build time (`scripts/build.mjs` defines `__OSHAWOTT_TARGET__`), so each bundle carries
// only its own browser's branch. Tests run without the define and get "chromium".

export type Target = "chromium" | "firefox";

declare const __OSHAWOTT_TARGET__: Target | undefined;

declare global {
	/**
	 * A `--dev` build: test hooks on (see `scripts/smoke-*.mjs`). Defined by the build only, and used as the bare
	 * identifier, so a non-dev build drops the hooks' code (`if (false)`); bundles only, never in tests.
	 */
	const __OSHAWOTT_DEV__: boolean;
}

export const TARGET: Target = typeof __OSHAWOTT_TARGET__ === "undefined" ? "chromium" : __OSHAWOTT_TARGET__;

/**
 * Where each role runs. The roles are the same on both browsers; only their placement differs:
 *
 * | role   | chromium                        | firefox                          |
 * |--------|---------------------------------|----------------------------------|
 * | broker | the service worker              | the event page                   |
 * | engine | the offscreen document          | the event page (same document)   |
 * | panel  | the side panel (`side_panel`)   | the sidebar (`sidebar_action`)   |
 * | page   | a content script, on demand     | a content script, on demand      |
 */
export const PLACEMENT = {
	chromium: { engineWithBroker: false },
	firefox: { engineWithBroker: true },
} as const satisfies Record<Target, { engineWithBroker: boolean }>;
