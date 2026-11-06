// The panel: the side panel (Chromium) or sidebar (Firefox). A Chord client of the Engine: it holds the workspace and
// the open chat, and renders their state. Every change arrives as a change of a held member; there are no messages
// to handle. When the Engine's document goes away, the references keep their values and come back on the next link.
import { Chat, Workspace } from "../contracts/chat.ts";
import { MESSAGES, PORTS, type Principal } from "../contracts/hosts.ts";
import { BACKGROUND_CONTEXT, createHost, type Reference } from "../lib/chord.ts";
import { portLink } from "../link/port-link.ts";
import "../platform/target.ts";
import { ext } from "../platform/webext.ts";
import { renderView } from "./render.ts";
import { selftest } from "./selftest.ts";

const context = BACKGROUND_CONTEXT;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const host = createHost<Principal>({ onError: (error) => console.debug("[oshawatt panel]", error) });

let backoff = 250;
async function connect() {
	try {
		await ext.runtime.sendMessage({ type: MESSAGES.ensureEngine });
	} catch {
		// The Broker answers once it is up; connecting tells the rest.
	}
	const link = portLink(ext.runtime.connect({ name: PORTS.panel }), () => ext.runtime.lastError?.message);
	host.connect(link, { principal: { kind: "engine" } }, context);
	void link.done.then(() => {
		setTimeout(connect, backoff);
		backoff = Math.min(backoff * 2, 10_000);
	});
}

async function main() {
	await connect();
	await host.load([], context);
	// A reference is live once `get` resolves, and stays usable across Engine restarts (it goes `loading`, then back).
	const workspace = await host.get(Workspace, {}, context);
	if (workspace.variant !== "owner") throw new Error("The Engine refused the panel.");
	let chat: Reference<typeof Chat> | undefined;
	let chatId: number | undefined;

	const status = (text: string) => ($("status").textContent = text);
	const chatSelect = $<HTMLSelectElement>("chats");
	const providerSelect = $<HTMLSelectElement>("provider");
	const modelSelect = $<HTMLSelectElement>("model");

	const renderWorkspace = () => {
		const chats = workspace.chats.value;
		chatSelect.replaceChildren(...chats.map((c) => new Option(c.title, String(c.id))));
		if (chatId !== undefined) chatSelect.value = String(chatId);
		const providers = workspace.providers.value;
		const chosen = providerSelect.value || workspace.defaultModel.value?.provider || providers[0]?.id || "";
		providerSelect.replaceChildren(
			...providers.map((p) => new Option(`${p.name}${p.configured ? " ✓" : ""}`, p.id)),
		);
		providerSelect.value = chosen;
		const models = providers.find((p) => p.id === chosen)?.models ?? [];
		modelSelect.replaceChildren(...models.map((m) => new Option(m.name, m.id)));
		const current = workspace.defaultModel.value;
		if (current?.provider === chosen) modelSelect.value = current.modelId;
	};

	const open = async (id: number) => {
		chat?.release();
		chatId = id;
		const next = await host.get(Chat, { id }, context);
		if (chatId !== id) return next.release();
		chat = next;
		const watch = await next.view.watch(context);
		const draw = () => renderView($("transcript"), next.view.value);
		draw();
		watch.start(async () => draw());
	};

	for (const member of [workspace.chats, workspace.providers, workspace.defaultModel]) {
		const watch = await member.watch(context);
		watch.start(async () => renderWorkspace());
	}
	renderWorkspace();
	const newest = workspace.chats.value.at(-1);
	if (newest) await open(newest.id);

	providerSelect.onchange = renderWorkspace;
	chatSelect.onchange = () => void open(Number(chatSelect.value));
	$("new").onclick = async () => {
		await open(await workspace.createChat({}, context));
	};
	$("save-key").onclick = async () => {
		const input = $<HTMLInputElement>("key");
		if (!input.value) return;
		await workspace.setApiKey({ provider: providerSelect.value, key: input.value }, context);
		input.value = "";
		status("Key saved.");
	};
	modelSelect.onchange = async () => {
		const model = { provider: providerSelect.value, modelId: modelSelect.value };
		await workspace.setDefaultModel(model, context);
		if (chat?.variant === "owner") await chat.configure(model, context);
	};

	const prompt = $<HTMLTextAreaElement>("prompt");
	const send = async () => {
		const text = prompt.value.trim();
		if (!text || chat?.variant !== "owner") return;
		prompt.value = "";
		const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
		const busy = chat.view.value?.docs["pi.live"] && (chat.view.value.docs["pi.live"] as { run?: unknown }).run;
		await chat.send(
			{ text, requestId: crypto.randomUUID(), tabId: tab?.id, ...(busy ? { whenBusy: "steer" as const } : {}) },
			context,
		);
	};
	$("send").onclick = send;
	prompt.onkeydown = (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void send();
		}
	};
	$("stop").onclick = () => void (chat?.variant === "owner" && chat.abort(context));

	if (__OSHAWATT_DEV__) {
		const origin = new URLSearchParams(location.search).get("selftest");
		if (origin) void selftest(origin);
	}
}

void main();
