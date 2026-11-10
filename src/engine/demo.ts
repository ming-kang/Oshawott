import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory, Message, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { NO_ACCESS } from "../contracts/browser.ts";

const DEMO_PROVIDER = "demo";

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

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)\]]+/i;

function fileFor(url: string): string {
	const name = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "";
	return /^[\w.-]{1,64}$/.test(name) && name.includes(".") ? name : "page.html";
}

function measureScript(path: string): string {
	const summary = `${path}.stats.json`;
	return [
		`const chunks = [];`,
		`for (let offset = 0; ; ) {`,
		`  const part = await tools.read_text({ path: ${JSON.stringify(path)}, offset });`,
		`  chunks.push(part.text);`,
		`  if (part.eof) break;`,
		`  offset = part.nextOffset;`,
		`}`,
		`const text = chunks.join("");`,
		String.raw`const lines = text.split("\n");`,
		`const measured = {`,
		`  path: ${JSON.stringify(path)},`,
		`  characters: text.length,`,
		`  lines: lines.length,`,
		String.raw`  words: text.split(/\s+/).filter(Boolean).length,`,
		`  firstLine: (lines.find((line) => line.trim()) ?? "").slice(0, 160),`,
		`};`,
		`await tools.write({ path: ${JSON.stringify(summary)}, content: JSON.stringify(measured, null, 2) });`,
		`return { ...measured, summary: ${JSON.stringify(summary)} };`,
	].join("\n");
}

function fetchFailed(error: string, zh: boolean) {
	const denied = error.includes(NO_ACCESS);
	if (zh) {
		return denied
			? "我还不能访问这个网站。点上面卡片里的 **允许访问此站点**，然后再发一次。"
			: `下载失败：${error}`;
	}
	return denied
		? "I can't reach this site yet. Use **Allow this site** on the card above, then send again."
		: `The download failed: ${error}`;
}

function measured(text: string, zh: boolean) {
	const block = ["```", text.trim(), "```"];
	return (
		zh
			? ["## 已下载", "", "文件在这个对话的文件里（右上角的文件按钮），代码模式量出来的结果：", "", ...block, "", "> 这是开发版的演示模型。"]
			: ["## Downloaded", "", "The file is in this chat's files (the Files button above). What the code mode script measured:", "", ...block, "", "> This is the dev build's demo model."]
	).join("\n");
}

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
		const requested = asked ? typeof asked.content === "string" ? asked.content : asked.content.map((block) => block.type === "text" ? block.text : "").join(" ") : "";
		const zh = CJK.test(requested);
		const url = URL_IN_TEXT.exec(requested)?.[0]?.replace(/[.,，。;；!?！？]+$/, "");
		const method = /^\s*POST\s+https?:\/\//i.test(requested) ? "POST" : "GET";
		if (last?.role === "toolResult" && last.toolName === "fetch") {
			const text = last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			if (last.isError) return fauxAssistantMessage(fetchFailed(text, zh));
			const saved = /Saved the body to (\S+)\.$/m.exec(text)?.[1] ?? "page.html";
			return fauxAssistantMessage(
				[
					fauxText(zh ? "下载好了，我用代码模式读一下这个文件。" : "Downloaded. Let me measure the file in code mode."),
					fauxToolCall("codemode", { code: measureScript(saved) }),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (last?.role === "toolResult" && last.toolName === "codemode") {
			const text = last.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			return fauxAssistantMessage(last.isError ? fetchFailed(text, zh) : measured(text, zh));
		}
		if (last?.role === "user" && url) {
			return fauxAssistantMessage(
				[
					fauxThinking(zh ? "用户给了一个网址。先下载到对话的文件里，再用代码模式处理。" : "The user gave an address. I download it into the chat's files, then process it in code mode."),
					fauxText(zh ? "我先把它下载下来。" : "Let me download it first."),
					fauxToolCall("fetch", { url, method, saveTo: fileFor(url) }),
				],
				{ stopReason: "toolUse" },
			);
		}
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

/**
 * Dev builds only: a provider whose only auth is a sign-in that needs no account. It shows a device code, then asks for
 * the code `demo`, so the smoke tests drive the real Engine sessions and Panel UI.
 */
export function demoAccountProvider(): Provider {
	const handle = fauxProvider({ provider: "demo-account", models: [{ id: "demo-account", name: "Demo account" }] });
	handle.setResponses([() => fauxAssistantMessage("Signed in to the demo account.")]);
	const credential = (): OAuthCredential => ({ type: "oauth", access: "demo-access", refresh: "demo-refresh", expires: Date.now() + 3_600_000 });
	return {
		...handle.provider,
		name: "Demo account",
		auth: {
			oauth: {
				name: "Demo account",
				loginLabel: "Sign in with the demo account",
				login: async (interaction) => {
					interaction.notify({ type: "device_code", userCode: "DEMO-1234", verificationUri: "https://example.com/device", expiresInSeconds: 600 });
					const code = await interaction.prompt({ type: "manual_code", message: "Enter demo", placeholder: "demo", signal: interaction.signal });
					if (code.trim() !== "demo") throw new Error("Missing authorization code");
					return credential();
				},
				refresh: async () => credential(),
				toAuth: async ({ access }) => ({ apiKey: access }),
			},
		},
	};
}
