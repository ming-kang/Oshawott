export interface FenceEnricher {
	/** Largest finalized source (in characters) the enricher will attempt; bigger fences keep the plain code display. */
	readonly maxLength: number;
	/** Render enriched content for `host`; return a cancel function for superseded passes and disposal. */
	render(host: FenceHost): (() => void) | void;
}

export interface FenceHost {
	/** The finalized diagram source (its trailing newline already trimmed). */
	readonly source: string;
	/** An empty, hidden container the enricher owns for its rendered output. */
	readonly target: HTMLElement;
	reveal(): void;
	/** Discard enriched content and reveal the plain code display; `failed` tints the block as an error fallback. */
	revert(failed?: boolean): void;
	/** True once a newer update or disposal has superseded this render pass. */
	stale(): boolean;
}

const fences = new Map<string, FenceEnricher>();

export function fenceLanguage(language: string): string {
	return language.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

export function registerFence(language: string, enricher: FenceEnricher): void {
	fences.set(fenceLanguage(language), enricher);
}

export function fenceEnricher(language: string): FenceEnricher | undefined {
	return fences.get(fenceLanguage(language));
}
