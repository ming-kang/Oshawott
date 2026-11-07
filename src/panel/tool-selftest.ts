import { NO_ACCESS } from "../contracts/browser.ts";
import { ext } from "../platform/webext.ts";
import { ToolCard } from "./tool-card.ts";

export async function testToolCards() {
	const names = ["read", "read_text", "write", "edit", "ls", "fetch"];
	const cards = names.map((name) => new ToolCard(name, { path: "notes.md", url: "https://denied.example:8443/" }));
	const labels = cards.map((card) => card.element.querySelector(".tool-label")?.textContent);
	const error = cards.at(-1)!;
	error.setResult(`<harness>\n[error] ${NO_ACCESS} denied.example:8443: the user has not allowed this site.`, true);
	document.body.append(error.element);
	const button = error.element.querySelector<HTMLButtonElement>(".tool-grant");
	const original = ext.permissions.request;
	const requests: unknown[] = [];
	let synchronous = false;
	try {
		ext.permissions.request = (permissions) => {
			requests.push(permissions);
			return Promise.resolve(true);
		};
		button?.click();
		synchronous = requests.length === 1;
		await Promise.resolve();
	} finally {
		ext.permissions.request = original;
		error.element.remove();
	}
	const unrelated = new ToolCard("fetch", { url: "https://denied.example/" });
	unrelated.setResult("Network error", true);
	return [
		{ name: "file tools have labeled, specialized cards", ok: labels.every((label, i) => Boolean(label) && label !== names[i]), detail: labels.join(", ") },
		{
			name: "fetch grant requests permission synchronously without a port in its pattern",
			ok: synchronous && JSON.stringify(requests) === JSON.stringify([{ origins: ["https://denied.example/*"] }]) && button?.disabled === true && !error.element.open && !unrelated.element.querySelector(".tool-grant"),
			detail: JSON.stringify(requests),
		},
	];
}
