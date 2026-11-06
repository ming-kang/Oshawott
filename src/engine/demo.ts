// A scripted model for `--dev` builds: the panel can be tried, and the smoke tests can run a whole turn, without a key.
// Asked anything, it reads the user's tab with `page_snapshot`, then answers from what it read, streamed at a readable
// pace, in the Markdown the panel renders (a heading, a list, a table, code).
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory, Message } from "@earendil-works/pi-ai";

export const DEMO_PROVIDER = "demo";

type Snapshot = { url?: string; title?: string; text?: string; elements?: { ref: string; role: string; name: string }[] };

function lastOf(messages: readonly Message[]) {
	return messages.at(-1);
}

const CJK = /\p{Script=Han}/u;

function answer(snapshot: Snapshot | undefined, error: string | undefined, zh: boolean) {
	if (!snapshot) return zh ? `没能读取页面：${error ?? "没有结果"}。` : `I could not read the page: ${error ?? "no result"}.`;
	const elements = snapshot.elements ?? [];
	const rows = elements
		.slice(0, 5)
		.map((e) => `| \`${e.ref}\` | ${e.role} | ${e.name.replace(/\|/g, "\\|") || "—"} |`)
		.join("\n");
	const text = snapshot.text ?? "";
	const size = zh ? `${[...text.replace(/\s+/g, "")].length} 个字符` : `${text.split(/\s+/).filter(Boolean).length} words`;
	const host = new URL(snapshot.url ?? "about:blank").host || (zh ? "这个页面" : "this page");
	const click = JSON.stringify({ tool: "page_click", args: { ref: elements[0]?.ref ?? "e1" } }, null, 2);
	return (
		zh
			? [
					`## ${snapshot.title || "无标题页面"}`,
					"",
					`我用 \`page_snapshot\` 读取了 **${host}**：`,
					"",
					`- 可见文字约 ${size}`,
					`- ${elements.length} 个可交互元素，前几个如下`,
					"",
					"| ref | 类型 | 名称 |",
					"|---|---|---|",
					rows || "| — | — | — |",
					"",
					"要操作其中一个，我会把它的 ref 交给工具：",
					"",
					"```json",
					click,
					"```",
					"",
					"> 这是开发版的演示模型。在设置里填入 API key 即可换成真实模型。",
				]
			: [
					`## ${snapshot.title || "Untitled page"}`,
					"",
					`I read **${host}** with \`page_snapshot\`:`,
					"",
					`- about ${size} of visible text`,
					`- ${elements.length} interactive elements, the first ones below`,
					"",
					"| ref | role | name |",
					"|---|---|---|",
					rows || "| — | — | — |",
					"",
					"To act on one, I pass its ref to a tool:",
					"",
					"```json",
					click,
					"```",
					"",
					"> This is the dev build's demo model. Add an API key in Settings for a real one.",
				]
	).join("\n");
}

/** Registers the demo provider on `models`; it answers every request, as many as are made. */
export function demoProvider() {
	const handle = fauxProvider({
		provider: DEMO_PROVIDER,
		models: [{ id: "demo-reader", name: "Demo (scripted)", reasoning: true }],
		tokensPerSecond: 60,
	});
	const respond: FauxResponseFactory = (context) => {
		handle.appendResponses([respond]);
		const last = lastOf(context.messages);
		const asked = [...context.messages].reverse().find((message) => message.role === "user");
		const zh = CJK.test(asked ? JSON.stringify(asked.content) : "");
		if (last?.role === "toolResult") {
			const text = last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			let snapshot: Snapshot | undefined;
			try {
				snapshot = last.isError ? undefined : (JSON.parse(text) as Snapshot);
			} catch {
				snapshot = undefined;
			}
			return fauxAssistantMessage(answer(snapshot, last.isError ? text : undefined, zh));
		}
		return fauxAssistantMessage(
			[
				fauxThinking(
					zh
						? "用户在问当前标签页。先用 page_snapshot 读取页面，再根据快照回答。"
						: "The user asks about their tab. I read it first, then answer from the snapshot.",
				),
				fauxText(zh ? "我先读一下这个页面。" : "Let me read the page first."),
				fauxToolCall("page_snapshot", { maxChars: 4000 }),
			],
			{ stopReason: "toolUse" },
		);
	};
	handle.setResponses([respond]);
	return { ...handle.provider, name: "Demo" };
}
