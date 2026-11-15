/**
 * A registry of code-fence enrichers. A plain code fence is shown as highlighted source; an
 * enricher swaps that source view for rendered output (e.g. a diagram) while keeping the source
 * as the always-available fallback. Enrichers are registered per language and looked up lazily,
 * so the heavy renderer for a language is only ever loaded when a fence for it actually appears.
 */

/** A code-fence enricher renders diagram-style content for a language, always keeping the plain source as fallback. */
export interface FenceEnricher {
	/** Largest finalized source (in characters) the enricher will attempt; bigger fences keep the plain code display. */
	readonly maxLength: number;
	/** Render enriched content for `host`; return a cancel function for superseded passes and disposal. */
	render(host: FenceHost): (() => void) | void;
}

/** The surface an enricher renders into, plus how it reveals, reverts, or detects a superseded pass. */
export interface FenceHost {
	/** The finalized diagram source (its trailing newline already trimmed). */
	readonly source: string;
	/** An empty, hidden container the enricher owns for its rendered output. */
	readonly target: HTMLElement;
	/** Reveal the enriched `target`, hiding the plain code display. */
	reveal(): void;
	/** Discard enriched content and reveal the plain code display; `failed` tints the block as an error fallback. */
	revert(failed?: boolean): void;
	/** True once a newer update or disposal has superseded this render pass. */
	stale(): boolean;
}

const fences = new Map<string, FenceEnricher>();

/** A fence's canonical language: the first whitespace-delimited token of its info string, lower-cased. */
export function fenceLanguage(language: string): string {
	return language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** Register (or replace) the enricher for a fenced language. */
export function registerFence(language: string, enricher: FenceEnricher): void {
	fences.set(fenceLanguage(language), enricher);
}

/** The enricher registered for a fence language, if any. */
export function fenceEnricher(language: string): FenceEnricher | undefined {
	return fences.get(fenceLanguage(language));
}
