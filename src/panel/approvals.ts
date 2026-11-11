import type { ApprovalDecision, ApprovalView } from "../contracts/chat.ts";
import { t } from "./i18n.ts";
import { toolLook } from "./tool-card.ts";
import { h, icon, toastError } from "./ui.ts";

/** The actions the open chat is waiting to be allowed, above the composer: the run stands still until each is answered. */
export class ApprovalBar {
	readonly element = h("section", { class: "approvals", id: "approvals", "aria-label": t("approval.title"), hidden: true });
	readonly #decide: (id: string, decision: ApprovalDecision) => Promise<unknown>;
	#shown = "";

	constructor(decide: (id: string, decision: ApprovalDecision) => Promise<unknown>) {
		this.#decide = decide;
	}

	update(items: readonly ApprovalView[]) {
		// Rebuilt only when the requests change, so a re-render never moves the button under the pointer.
		const shown = items.map((item) => item.id).join();
		if (shown === this.#shown) return;
		const held = this.element.contains(document.activeElement);
		this.#shown = shown;
		this.element.hidden = items.length === 0;
		this.element.replaceChildren(...items.map((item) => this.#item(item)));
		if (held) this.element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
	}

	#item(item: ApprovalView) {
		const { icon: name, label } = toolLook(item.tool, {});
		const buttons: HTMLButtonElement[] = [];
		const button = (decision: ApprovalDecision, text: string, kind: string) => {
			const node = h("button", {
				class: `btn small ${kind}`, type: "button", "data-decision": decision,
				onclick: () => {
					for (const each of buttons) each.disabled = true;
					void this.#decide(item.id, decision).catch((error) => {
						for (const each of buttons) each.disabled = false;
						toastError(error);
					});
				},
			}, text);
			buttons.push(node);
			return node;
		};
		return h("article", { class: "approval", "data-approval": item.id, "data-tool": item.tool, role: "alertdialog", "aria-label": t("approval.title") },
			h("div", { class: "approval-head" }, h("span", { class: "tool-icon" }, icon(name, 14)),
				h("strong", null, t("approval.ask", label)), h("span", { class: "approval-site" }, item.site)),
			h("div", { class: "approval-target", title: item.target }, item.target),
			h("div", { class: "approval-actions" },
				button("deny", t("approval.deny"), "ghost"), button("allow_chat", t("approval.allowChat"), ""), button("allow", t("approval.allow"), "primary")),
		);
	}
}
