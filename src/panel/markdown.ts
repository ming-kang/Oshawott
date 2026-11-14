import { getMarkdown, type MarkdownToken, type MathOptions, type ParsedNode, parseMarkdownToStructure } from "stream-markdown-parser";

/** Extension pages must never resolve model-authored relative URLs against their own origin. */
export function safeUrl(value: string): string | undefined {
	const source = value.trim();
	if (/[\u0000-\u0020\u007f-\u009f]/.test(source) || !/^(?:https?:\/\/|mailto:)/i.test(source)) return;
	try {
		const url = new URL(source);
		return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
	} catch {
		return;
	}
}

export function safeImageUrl(value: string): string | undefined {
	const url = safeUrl(value);
	return url && /^https?:/i.test(url) ? url : undefined;
}

const validateLink = (url: string) => safeUrl(url) !== undefined;
const mathOptions = { strictDelimiters: true, commands: [], escapeExclamation: false } satisfies MathOptions;
const parserOptions = {
	markdownItOptions: { html: false, typographer: false, linkify: true, breaks: true, stream: false, validateLink },
	enableFixIndentedCodeBlock: false,
	mathOptions,
};
const streamingParser = getMarkdown("oshawott", parserOptions);
// Do not let the streaming URL repair rule discard literal source before finalText sees it.
const finalParser = getMarkdown("oshawott-final", parserOptions).disable("fix_link_tokens");

/** The upstream AST recovery still repairs some literal tokens at final EOF (e.g. an unmatched `).
 * Use its literal-token path for what the tokenizer already classified as text, not another parser.
 */
function finalText(tokens: MarkdownToken[]): MarkdownToken[] {
	let inert = false;
	return tokens.flatMap((token, index): MarkdownToken[] => {
		// An inferred URL in an unfinished destination is literal, not a completed link.
		const previous = tokens[index - 1];
		if (token.type === "link_open" && token.markup === "linkify" && previous?.type === "text" && /\]\($/.test(previous.content ?? "")) {
			inert = true;
			return [];
		}
		if (token.type === "link_close" && inert) {
			inert = false;
			return [];
		}
		if (token.type === "text") return [{ ...token, type: "text_special" }];
		return [token.children ? { ...token, children: finalText(token.children) } : token];
	});
}

/**
 * Parse the real buffer, never a source with synthetic closing markers. Reparse the
 * whole document: later reference/footnote definitions can change earlier nodes.
 * UI updates are frame-coalesced; DOM reconciliation, not a frozen prefix, retains state.
 */
export function parseMarkdown(source: string, streaming = false): ParsedNode[] {
	try {
		return parseMarkdownToStructure(source, streaming ? streamingParser : finalParser, {
			final: !streaming, requireClosingStrong: !streaming, streamParse: false,
			validateLink, preTransformTokens: streaming ? undefined : finalText,
		});
	} catch {
		// A malformed block must not take down the transcript or lose the answer.
		return [{ type: "text", content: source, raw: source }];
	}
}
