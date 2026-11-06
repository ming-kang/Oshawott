// Renders Durable's conversation view: committed entries, then what `pi.live` streams (the partial answer and the
// running tools). Text only, never HTML from the model or a page.
import type { ConversationView } from "@earendil-works/pi-durable";

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
type Message = { role?: string; content?: string | Block[]; toolName?: string; isError?: boolean };

function line(role: string, text: string) {
	const div = document.createElement("div");
	div.className = `msg ${role}`;
	div.textContent = text;
	return div;
}

function textOf(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.map((block) =>
			block.type === "text" ? block.text : block.type === "toolCall" ? `→ ${block.name} ${JSON.stringify(block.arguments)}` : "",
		)
		.filter(Boolean)
		.join("\n");
}

export function renderView(root: HTMLElement, view: ConversationView | null) {
	if (!view) return root.replaceChildren(line("note", "Connecting…"));
	const nodes: HTMLElement[] = [];
	for (const entry of view.entries as unknown as { kind: string; model?: Message[] }[]) {
		const message = entry.model?.[0];
		if (!message) continue;
		if (entry.kind === "pi.user") nodes.push(line("user", textOf(message.content)));
		else if (entry.kind === "pi.assistant") nodes.push(line("assistant", textOf(message.content)));
		else if (entry.kind === "pi.tool-result") {
			const text = textOf(message.content);
			nodes.push(line(message.isError ? "tool error" : "tool", `${message.toolName}: ${text.slice(0, 300)}${text.length > 300 ? "…" : ""}`));
		}
	}
	const live = view.docs["pi.live"] as
		| { run?: unknown; generation?: { message?: Message }; tools?: { name: string; status: string }[]; runFailure?: { reason: string; detail?: string } }
		| undefined;
	if (live?.generation?.message) nodes.push(line("assistant streaming", textOf(live.generation.message.content)));
	for (const tool of live?.tools ?? []) if (tool.status !== "done") nodes.push(line("tool running", `${tool.name}…`));
	if (live?.runFailure) nodes.push(line("note", `Run ended: ${live.runFailure.reason}${live.runFailure.detail ? ` (${live.runFailure.detail})` : ""}`));
	root.replaceChildren(...nodes);
	root.scrollTop = root.scrollHeight;
	document.body.classList.toggle("busy", Boolean(live?.run));
}
