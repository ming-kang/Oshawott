import { defineComponent, shallowRef, type PropType } from "vue";
import { BACKGROUND_CONTEXT } from "../lib/chord.ts";
import type { ApprovalDecision, ApprovalView } from "../contracts/chat.ts";
import { Icon } from "./components.tsx";
import type { PanelController } from "./controller.ts";
import { t } from "./i18n/index.ts";
import { toolLook } from "./tool-card.ts";
import { toastError } from "./ui.ts";

const ApprovalItem = defineComponent({
	props: {
		controller: { type: Object as PropType<PanelController>, required: true },
		item: { type: Object as PropType<ApprovalView>, required: true },
	},
	setup(props) {
		const pending = shallowRef(false);
		const decide = (decision: ApprovalDecision) => {
			if (pending.value) return;
			pending.value = true;
			void props.controller.session.opened.decide({ id: props.item.id, decision }, BACKGROUND_CONTEXT)
				.catch((error) => { pending.value = false; toastError(error); });
		};
		return () => {
			const look = toolLook(props.item.tool, {});
			return (
				<article class="approval" data-approval={props.item.id} data-tool={props.item.tool} role="alertdialog" aria-label={t("approval.title")}>
					<div class="approval-head"><span class="tool-icon"><Icon name={look.icon} size={14} /></span>
						<strong>{t("approval.ask", look.label)}</strong><span class="approval-site">{props.item.site}</span></div>
					<div class="approval-target" title={props.item.target}>{props.item.target}</div>
					<div class="approval-actions">
						<button class="btn small ghost" type="button" data-decision="deny" disabled={pending.value} onClick={() => decide("deny")}>{t("approval.deny")}</button>
						<button class="btn small" type="button" data-decision="allow_chat" disabled={pending.value} onClick={() => decide("allow_chat")}>{t("approval.allowChat")}</button>
						<button class="btn small primary" type="button" data-decision="allow" disabled={pending.value} onClick={() => decide("allow")}>{t("approval.allow")}</button>
					</div>
				</article>
			);
		};
	},
});

export const ApprovalBar = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		return () => (
			<section class="approvals" id="approvals" aria-label={t("approval.title")} hidden={!props.controller.store.approvals.value.length}>
				{props.controller.store.approvals.value.map((item) => <ApprovalItem controller={props.controller} item={item} key={item.id} />)}
			</section>
		);
	},
});
