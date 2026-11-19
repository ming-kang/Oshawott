import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationView, type EntryId, type EntryRecord, type LiveState, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { MarkdownView } from "../markdown-dom.ts";
import { TranscriptFixture } from "./fixtures.tsx";
import { h } from "../ui.ts";
import { until } from "./dom.ts";

const actions = { suggest() {}, openSettings() {}, chooseModel() {}, allowed() {}, retry: async () => undefined, readFile: async () => new Uint8Array() };
const conversation = { id: ROOT_CONVERSATION_ID };
const frames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const mathSettled = (view: MarkdownView) => {
	const maths = [...view.element.querySelectorAll(".math")];
	return maths.length > 0 && maths.every((node) => node.hasAttribute("data-rendered") || node.hasAttribute("data-error"));
};

/** Real DOM tests in both extensions, under their actual CSP and with only local fixtures. */
export async function testMarkdown(origin?: string) {
	const steps: { name: string; ok: boolean; detail?: string }[] = [];
	const step = (name: string, ok: boolean, detail?: string) => steps.push({ name, ok, detail });
	const fixture = h("div", { style: "position:fixed;top:0;left:0;width:320px;height:500px;overflow:auto;background:var(--bg);z-index:1000" });
	const transcript = new TranscriptFixture(actions);
	const tools = new TranscriptFixture(actions);
	const views: MarkdownView[] = [];
	const addView = (source: string, streaming = false) => {
		const view = new MarkdownView(source, streaming);
		views.push(view);
		fixture.append(view.element);
		return view;
	};
	fixture.append(transcript.element);
	document.body.append(fixture);
	const write = navigator.clipboard.writeText;
	const originalFocus = document.activeElement;
	const selection = document.getSelection();
	const originalSelection = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
	let copied = "";
	try {
		navigator.clipboard.writeText = async (text) => { copied = text; };
		const source = `A stable paragraph.\n\n\`\`\`ts\nconst result = "${"otter".repeat(30)}";`;
		const message = (text: string, thinking = "Reading the page.") => fauxAssistantMessage([fauxThinking(thinking), fauxText(text)], { timestamp: 1700000000000 });
		const view = (text: string, thinking?: string): ConversationView => {
			const partial = message(text, thinking);
			const live: LiveState = { run: { taskId: 42 as TaskId, inputs: [], turns: 0 }, generation: { attempt: 1, message: {
				role: "assistant", content: [{ type: "thinking", thinking: thinking ?? "Reading the page." }, { type: "text", text }],
				api: partial.api, provider: partial.provider, model: partial.model, usage: partial.usage, stopReason: partial.stopReason, timestamp: partial.timestamp,
			} } };
			return { conversation, entries: [], docs: { "pi.live": live } };
		};
		await transcript.update({ kind: "conversation", view: view(source), ready: true });
		const answer = transcript.element.querySelector(".msg.assistant")!;
		const thinking = answer.querySelector<HTMLDetailsElement>(".thinking")!;
		thinking.open = true;
		const paragraph = answer.querySelector(":scope > .md > p")!;
		const codeblock = answer.querySelector(".codeblock")!;
		const pre = codeblock.querySelector("pre")!;
		pre.scrollLeft = 60;
		const left = pre.scrollLeft;
		const copy = codeblock.querySelector<HTMLButtonElement>(".code-copy")!;
		copy.focus();
		const range = document.createRange();
		range.setStart(paragraph.firstChild!, 2);
		range.setEnd(paragraph.firstChild!, 8);
		selection?.removeAllRanges();
		selection?.addRange(range);
		const selected = selection?.toString();
		const next = `${source}\nconsole.log(result);`;
		await transcript.update({ kind: "conversation", view: view(next, "Reading the page. Found the content."), ready: true });
		const afterStreaming = selection?.toString();
		step("Markdown streaming preserves the answer, completed paragraphs and thinking disclosure", transcript.element.querySelector(".msg.assistant") === answer
			&& answer.querySelector(":scope > .md > p") === paragraph && answer.querySelector(".thinking") === thinking && thinking.open);
		step("streaming code retains its scroll position, controls and keyboard focus", answer.querySelector(".codeblock") === codeblock
			&& codeblock.querySelector("pre") === pre && left > 0 && pre.scrollLeft === left && document.activeElement === copy, `scrollLeft=${pre.scrollLeft}`);
		copy.click();
		await Promise.resolve();
		step("a retained code copy button copies the latest source, without the streaming cursor", copied === next.split("```ts\n")[1], copied.slice(-45));

		codeblock.querySelector<HTMLButtonElement>(".code-wrap")!.click();
		// A control click may change a native selection; isolate the commit from that interaction.
		selection?.removeAllRanges();
		selection?.addRange(range);
		const beforeCommit = selection?.toString();
		const final = `${next}\n\`\`\``;
		await transcript.update({ kind: "conversation", ready: true, view: {
			conversation, docs: {},
			entries: [{ id: 1 as EntryId, byTaskId: 42 as TaskId, conversationId: conversation.id, kind: "pi.assistant", model: [message(final, "Reading the page. Found the content.")] }],
		} });
		step("committing a streamed answer promotes its existing DOM and removes only the live state", transcript.element.querySelector(".msg.assistant") === answer
			&& answer.querySelector(".codeblock") === codeblock && !answer.hasAttribute("data-live") && !answer.querySelector(".caret") && !transcript.busy);
		step("code wrap preference survives finalization", getComputedStyle(pre).whiteSpace === "pre-wrap" && codeblock.querySelector(".code-wrap")?.getAttribute("aria-pressed") === "true");
		step("a selection in completed prose survives streaming updates and commit", selected === "stable" && afterStreaming === selected && beforeCommit === selected && selection?.toString() === selected
			&& selection.anchorNode === paragraph.firstChild && selection.anchorOffset === 2 && selection.focusOffset === 8,
			JSON.stringify({ selected, afterStreaming, beforeCommit, after: selection?.toString(), anchor: selection?.anchorOffset, focus: selection?.focusOffset }));
		selection?.removeAllRanges();
		await until(() => codeblock.querySelector(".hljs-keyword"));
		step("declared code languages receive real highlighting without changing the source or controls", codeblock.querySelector("code")?.textContent === next.split("```ts\n")[1]
			&& codeblock.querySelector(".code-copy") === copy && codeblock.querySelector("pre") === pre);

		const links = addView("[Otter](https://en.wikipedia.org/wiki/Otter_(species))").element;
		step("Markdown link destinations preserve balanced parentheses", links.querySelector("a")?.getAttribute("href") === "https://en.wikipedia.org/wiki/Otter_(species)");
		const rich = addView("Checklist\n===\n\n- [x] Read the page\n- [ ] Summarize\n\nSource[^a]\n\n[^a]: A useful note.").element;
		const checkboxes = [...rich.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		step("setext headings, task checkboxes and scoped footnotes render as semantic DOM", rich.querySelector("h2")?.textContent === "Checklist"
			&& checkboxes.length === 2 && checkboxes.every((input) => input.disabled) && checkboxes[0]!.checked && !checkboxes[1]!.checked && Boolean(rich.querySelector(".md-footnote-ref")));

		const referenceSource = "Read [docs][ref].\n\nA stable paragraph.\n\nNote[^a]";
		const references = addView(referenceSource, true);
		const first = references.element.children[0];
		const stable = references.element.children[1];
		const defined = `${referenceSource}\n\n[ref]: https://example.com/docs\n[^a]: A note.`;
		references.update(defined, true);
		const footnote = references.element.querySelector<HTMLElement>(".md-footnote")!;
		step("late definitions update earlier references without rebuilding unrelated paragraphs", references.element.children[0] === first && references.element.children[1] === stable
			&& first?.querySelector("a")?.getAttribute("href") === "https://example.com/docs");
		references.update(`${defined}\n\nMore text.`, true);
		const secondNotes = addView(defined).element;
		const ref = references.element.querySelector<HTMLAnchorElement>(".md-footnote-ref")!;
		ref.click();
		const focusedNote = document.activeElement === footnote;
		footnote.querySelector<HTMLAnchorElement>(".md-footnote-back")!.click();
		step("footnotes retain identity as text grows, stay scoped to their document and navigate both ways", references.element.querySelector(".md-footnote") === footnote
			&& ref.getAttribute("href") !== secondNotes.querySelector(".md-footnote-ref")?.getAttribute("href") && focusedNote && document.activeElement === ref);

		const provisional = addView("[docs](https://example.com/part", true);
		const label = provisional.element.textContent;
		provisional.update("[docs](https://example.com/part");
		step("partial destinations never create clickable links, including on EOF", !provisional.element.querySelector("a") && label === "docs" && provisional.element.textContent === "[docs](https://example.com/part");
		provisional.update("[docs](https://example.com/part)");
		step("a completed link opens externally with isolation", provisional.element.querySelector("a")?.target === "_blank"
			&& provisional.element.querySelector("a")?.rel === "noopener noreferrer");
		const unfinishedImageSource = "![alt](https://example.com/a.png";
		const unfinishedImage = addView(unfinishedImageSource, true);
		const disabled = unfinishedImage.element.querySelector<HTMLButtonElement>("button")?.disabled;
		unfinishedImage.update(unfinishedImageSource);
		step("unfinished images finalize as readable source without offering a network load", disabled === true
			&& !unfinishedImage.element.querySelector("img, a, button") && unfinishedImage.element.textContent === unfinishedImageSource);

		const unsafe = addView('<script>globalThis.__mdXss = 1</script>\n\n<iframe srcdoc="<script>alert(1)</script>"></iframe>\n\n<img src="https://invalid.example/track" onerror="alert(1)">\n\n<style>body { display:none }</style>\n\n[bad](javascript:alert(1)) [file](file:///private) [local](/panel.html) [ok](https://example.com)');
		step("untrusted HTML is literal and unsafe or extension-local destinations are inert", !unsafe.element.querySelector("script, style, iframe, img, form, object, embed, base")
			&& [...unsafe.element.querySelectorAll("a")].every((link) => /^https?:|^mailto:/.test(link.href)) && Boolean(unsafe.element.querySelector('a[href="https://example.com/"]')));
		const codeSource = '<img src="https://invalid.example/track" onerror="alert(1)">';
		const htmlCode = addView(`\`\`\`html\n${codeSource}\n\`\`\``);
		await until(() => htmlCode.element.querySelector(".hljs-name"));
		step("highlighted HTML remains code, not executable elements", !htmlCode.element.querySelector("img, script") && htmlCode.element.querySelector("code")?.textContent === codeSource);

		const changedCode = addView("```ts\nconst old = 1;", true);
		changedCode.update("```ts\nconst fresh = 2;\n```");
		await until(() => changedCode.element.querySelector(".hljs-keyword"));
		step("pending highlighter work cannot overwrite a newer code buffer", changedCode.element.querySelector("code")?.textContent === "const fresh = 2;");
		changedCode.update("```unknown-language\n<plain & literal>\n```");
		await frames();
		step("unknown languages fall back to literal source without stale coloring", changedCode.element.querySelector("code")?.textContent === "<plain & literal>" && !changedCode.element.querySelector("code span"));

		const diagram = addView("```mermaid\ngraph TD; A[One]-->B[Two];\n```");
		await until(() => diagram.element.querySelector(".codeblock-view svg"));
		step("Mermaid fences render local SVG under the extension CSP", diagram.element.querySelector(".codeblock-view")?.textContent?.includes("One") === true
			&& !diagram.element.querySelector(".codeblock-view script, .codeblock-view foreignObject") && diagram.element.querySelector<HTMLElement>("pre")?.hidden === true);
		const streamedDiagram = addView("```mermaid\ngraph TD; A[Streamed]-->B;", true);
		diagram.update("```mermaid\ngraph TD; A[Changed]-->B[Two];\n```");
		streamedDiagram.update("```mermaid\ngraph TD; A[Streamed]-->B;\n```");
		await until(() => streamedDiagram.element.querySelector(".codeblock-view svg")?.textContent?.includes("Streamed"));
		step("closing an unchanged streaming fence starts its enricher", streamedDiagram.element.querySelector("pre")?.hasAttribute("hidden") === true);
		await until(() => diagram.element.querySelector(".codeblock-view svg")?.textContent?.includes("Changed"));
		diagram.update("```ts\nconst plainCode = 1;\n```");
		step("fence enrichment is revision-safe and ordinary code returns to source", diagram.element.querySelector<HTMLElement>("pre")?.hidden === false
			&& diagram.element.querySelector("code")?.textContent === "const plainCode = 1;" && diagram.element.querySelector<HTMLElement>(".codeblock-view")?.hidden === true);

		const math = addView(String.raw`Euler: $e^{i\pi}+1=0$.

$$\frac{a}{b}=\sqrt{x}$$`);
		await until(() => mathSettled(math));
		step("KaTeX renders inline and display formulas with accessible MathML under the extension CSP", math.element.querySelectorAll(".katex").length === 2
			&& Boolean(math.element.querySelector(".katex-display math, .math-block math")) && math.element.querySelector("annotation")?.textContent === String.raw`e^{i\pi}+1=0`);
		const fonts = await document.fonts.load("16px KaTeX_Main");
		step("math fonts load from the packaged stylesheet", fonts.length > 0 && fonts.every((font) => font.status === "loaded"));
		math.element.querySelector<HTMLButtonElement>(".math-actions button")!.click();
		await Promise.resolve();
		step("formula copying returns TeX, not generated HTML or MathML", copied === String.raw`\frac{a}{b}=\sqrt{x}`);
		math.update("$x$");
		math.update("$y^2$");
		await until(() => math.element.querySelector("annotation")?.textContent === "y^2");
		step("late typesetting results cannot overwrite a newer formula", math.element.querySelectorAll(".katex").length === 1);
		math.update(String.raw`$\notACommand{x}$`);
		await until(() => mathSettled(math));
		step("invalid TeX remains readable source without breaking the rest of the document", Boolean(math.element.querySelector(".math[data-error]"))
			&& math.element.querySelector(".math-body")?.textContent === String.raw`\notACommand{x}`);

		const mathSecurity = addView(String.raw`$\href{javascript:alert(1)}{go}$ $\includegraphics{https://invalid.example/track.png}$ $\htmlStyle{background-image:url(https://invalid.example/track)}{x}$`);
		await until(() => mathSettled(mathSecurity));
		step("TeX cannot create links, load remote images or inject arbitrary styles", !mathSecurity.element.querySelector("a, img")
			&& ![...mathSecurity.element.querySelectorAll<HTMLElement>("[style]")].some((node) => node.style.cssText.includes("invalid.example")));
		const macros = addView(String.raw`$\gdef\foo{x}\foo$ and $\foo$`);
		await until(() => mathSettled(macros));
		const expressions = macros.element.querySelectorAll(".math");
		step("formula macros are scoped to one expression", expressions[0]?.hasAttribute("data-rendered") === true && expressions[1]?.hasAttribute("data-error") === true);
		const recursive = addView(String.raw`$\def\loop{\loop}\loop$`);
		await until(() => mathSettled(recursive));
		step("recursive TeX stops at the expansion bound and preserves its source", Boolean(recursive.element.querySelector(".math[data-error]")) && recursive.element.textContent === String.raw`\def\loop{\loop}\loop`);
		const retired = addView("$$x^2$$");
		retired.dispose();
		retired.element.remove();
		await frames();
		step("retired Markdown views cancel queued enrichment", !retired.element.querySelector(".katex"));

		const hits = () => fetch(new URL("/markdown-image-hits", origin!)).then((response) => response.json()) as Promise<{ count: number; referer?: string }>;
		const before = origin ? await hits() : undefined;
		const imageUrl = new URL("/markdown-image.png", origin ?? "https://images.example").href;
		const image = addView(`![An otter](${imageUrl})`);
		step("Markdown images require explicit loading", !image.element.querySelector("img") && Boolean(image.element.querySelector("button:not(:disabled)")));
		if (origin) {
			await frames();
			const unrequested = await hits();
			step("rendering a Markdown image causes no network request", unrequested.count === before!.count);
			image.element.querySelector<HTMLButtonElement>("button")!.click();
			// Firefox defers lazy images outside the fixture's 500px viewport; diagram tests above
			// made that off-screen position deterministic. Simulate the user seeing the consent button.
			image.element.scrollIntoView({ block: "center" });
			try {
				await until(() => image.element.querySelector("img")?.naturalWidth);
			} catch (error) {
				throw new Error(`${(error as Error).message}; image=${image.element.innerHTML.slice(0, 400)}; hits=${JSON.stringify(await hits())}`);
			}
			const after = await hits();
			step("explicit image loading uses the local server without a referrer", after.count === before!.count + 1 && !after.referer && image.element.querySelector("img")?.referrerPolicy === "no-referrer");
		}
		image.update("![Another image](https://invalid.example/other.png)");
		step("image consent does not transfer to a different URL", !image.element.querySelector("img") && Boolean(image.element.querySelector("button:not(:disabled)")));

		fixture.append(tools.element);
		const partial = fauxAssistantMessage("");
		const live: LiveState = { run: { taskId: 75 as TaskId, inputs: [], turns: 0 }, generation: { attempt: 1, message: {
			role: "assistant", content: [{ type: "toolCall", id: "live-call", name: "write", arguments: { path: "notes.txt", content: "draft" } }],
			api: partial.api, provider: partial.provider, model: partial.model, usage: partial.usage, stopReason: partial.stopReason, timestamp: partial.timestamp,
		} } };
		const updateTools = (entries: EntryRecord[], liveState?: LiveState) => tools.update({ kind: "conversation", ready: true, view: { conversation, entries, docs: liveState ? { "pi.live": liveState } : {} } });
		await updateTools([], live);
		const call = tools.element.querySelector<HTMLDetailsElement>(".tool")!;
		call.open = true;
		live.generation!.message!.content = [{ type: "toolCall", id: "live-call", name: "write", arguments: { path: "report.md", content: "final content" } }];
		await updateTools([], live);
		step("streaming tool arguments update without resetting their disclosure", tools.element.querySelector(".tool") === call && call.open && call.querySelector(".tool-meta")?.textContent === "report.md" && call.textContent?.includes("final content") === true);
		const own = tools.element.querySelector(".msg.assistant[data-live]");
		const unrelated: EntryRecord = { id: 1 as EntryId, byTaskId: 99 as TaskId, conversationId: conversation.id, kind: "pi.assistant", model: [fauxAssistantMessage("An unrelated entry")] };
		await updateTools([unrelated], live);
		step("an unrelated committed assistant cannot consume the active generation", tools.element.querySelector(".msg.assistant[data-live]") === own);
		await updateTools([unrelated,
			{ id: 2 as EntryId, byTaskId: 75 as TaskId, conversationId: conversation.id, kind: "pi.assistant", model: [fauxAssistantMessage(fauxToolCall("write", { path: "report.md", content: "final content" }, { id: "live-call" }), { stopReason: "toolUse", timestamp: partial.timestamp })] },
			{ id: 3 as EntryId, conversationId: conversation.id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "live-call", toolName: "write", content: [{ type: "text", text: "Saved report." }], isError: false, timestamp: 0 }] },
		]);
		step("promoted live tool cards receive results in place, without orphan duplicates", tools.element.querySelectorAll(".tool").length === 1 && tools.element.querySelector(".tool") === call && call.open && call.dataset.status === "done" && call.textContent?.includes("Saved report.") === true);

		const retry = view("```ts\nconst oldAttempt = 1;");
		await transcript.update({ kind: "conversation", view: retry, ready: true });
		const oldAttempt = transcript.element.querySelector(".msg.assistant[data-live]")!;
		(retry.docs["pi.live"] as LiveState).generation!.attempt = 2;
		(retry.docs["pi.live"] as LiveState).generation!.message!.content = [{ type: "text", text: "```ts\nconst freshAttempt = 2;\n```" }];
		await transcript.update({ kind: "conversation", view: retry, ready: true });
		await until(() => transcript.element.querySelector(".hljs-keyword"));
		step("a retry owns a new view and cancels the previous attempt's work", transcript.element.querySelector(".msg.assistant[data-live]") !== oldAttempt && !oldAttempt.isConnected
			&& transcript.element.querySelector(".msg[data-live] .codeblock code")?.textContent === "const freshAttempt = 2;",
			JSON.stringify({ oldConnected: oldAttempt.isConnected, fixtureContains: transcript.element.contains(oldAttempt), oldParent: oldAttempt.parentElement?.outerHTML.slice(0, 300), answers: [...transcript.element.querySelectorAll(".msg.assistant")].map((node) => ({ live: node.hasAttribute("data-live"), text: node.textContent })) }));
	} finally {
		navigator.clipboard.writeText = write;
		for (const view of views) view.dispose();
		transcript.dispose();
		tools.dispose();
		fixture.remove();
		selection?.removeAllRanges();
		for (const range of originalSelection) selection?.addRange(range);
		if (originalFocus instanceof HTMLElement && originalFocus.isConnected) originalFocus.focus({ preventScroll: true });
	}
	return [...steps, ...await testScrollFollow()];
}

/** Exercise the real panel's late-height observer, not a separate test scroller. */
async function testScrollFollow() {
	const scroller = document.querySelector<HTMLElement>("#scroller")!;
	const thread = scroller.querySelector<HTMLElement>(".thread")!;
	const jump = document.querySelector<HTMLButtonElement>(".jump")!;
	const filler = h("div", { style: `min-height:${scroller.clientHeight + 500}px;flex-shrink:0` });
	const gap = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
	const originalTop = scroller.scrollTop;
	const pinned = gap() < 72;
	const steps = [];
	try {
		thread.append(filler);
		await frames();
		scroller.scrollTo({ top: scroller.scrollHeight });
		await frames();
		filler.style.minHeight = `${filler.offsetHeight + 200}px`;
		await frames();
		steps.push({ name: "late content growth keeps a bottom-pinned reader at the bottom", ok: gap() < 2 && jump.hidden === true, detail: `gap=${gap()}` });
		scroller.scrollTop = Math.max(0, scroller.scrollTop - 300);
		await frames();
		const reading = scroller.scrollTop;
		filler.style.minHeight = `${filler.offsetHeight + 200}px`;
		await frames();
		steps.push({ name: "late content growth does not pull a reader away from earlier messages", ok: Math.abs(scroller.scrollTop - reading) < 2 && !jump.hidden, detail: `scrollTop=${reading} → ${scroller.scrollTop}` });

		// A small upward wheel step leaves the gap under the old 72px threshold; intent, not distance, ends following.
		scroller.scrollTo({ top: scroller.scrollHeight });
		await frames();
		scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40, bubbles: true }));
		scroller.scrollTop = Math.max(0, scroller.scrollTop - 40);
		await frames();
		const wheeled = scroller.scrollTop;
		filler.style.minHeight = `${filler.offsetHeight + 200}px`;
		await frames();
		steps.push({ name: "an upward wheel on a pinned reader ends follow; growth keeps position and shows jump", ok: Math.abs(scroller.scrollTop - wheeled) < 2 && !jump.hidden, detail: `scrollTop=${wheeled} → ${scroller.scrollTop}` });
	} finally {
		filler.remove();
		scroller.scrollTop = pinned ? scroller.scrollHeight : originalTop;
		await frames();
	}
	return steps;
}
