import { createApp } from "vue";
import { PanelApp } from "./app.tsx";
import { createPanelHost } from "./connection.ts";
import { PanelController } from "./controller.ts";
import { language } from "./i18n/index.ts";
import { initializeTheme } from "./settings.tsx";
import { testAttachmentComposer } from "./selftest/attachments.ts";
import { testMarkdown } from "./selftest/markdown.ts";
import { testPageTools } from "./selftest/page-tools.ts";
import { testPanel } from "./selftest/panel.ts";
import { selftest } from "./selftest/run.ts";
import { testToolCards } from "./selftest/tool-cards.ts";
import { toastError } from "./ui.ts";

initializeTheme();
document.documentElement.lang = language();
const controller = new PanelController(createPanelHost());
createApp(PanelApp, { controller }).mount(document.body);

void controller.start().then((held) => {
	if (!__OSHAWOTT_DEV__) return;
	const panelTests = (origin?: string) => testPanel(held, origin);
	(globalThis as { __oshawottTest?: unknown }).__oshawottTest = {
		toolCards: testToolCards, markdown: testMarkdown, panel: panelTests,
		attachments: testAttachmentComposer, pageTools: testPageTools,
	};
	const origin = new URLSearchParams(location.search).get("selftest");
	if (origin) void selftest(origin, panelTests);
}).catch(toastError);
