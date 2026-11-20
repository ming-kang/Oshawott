import { defineComponent, nextTick, onBeforeUnmount, onMounted, shallowRef, watch, type PropType } from "vue";
import { ApprovalBar } from "./approvals.tsx";
import { Composer } from "./composer.tsx";
import type { PanelController } from "./controller.ts";
import { Icon } from "./components.tsx";
import { MessageQueue } from "./queue.tsx";
import { OverlayHost } from "./overlay-host.tsx";
import { Transcript } from "./transcript.tsx";
import { t } from "./i18n/index.ts";

export const PanelApp = defineComponent({
	props: { controller: { type: Object as PropType<PanelController>, required: true } },
	setup(props) {
		const { controller } = props;
		const { store, composer } = controller;
		const scroller = controller.scroller;
		const dock = composer.dock;
		const jump = shallowRef(false);
		let followBottom = true;
		// A smooth toBottom() crosses far gaps on the way down; they must not look like a reader leaving.
		let programmatic = false;
		let pointerDown = false;
		let snapFrame = 0;
		let dockObserver: ResizeObserver | undefined;
		let threadObserver: ResizeObserver | undefined;
		const nearBottom = () => {
			const element = scroller.value;
			return !element || element.scrollHeight - element.scrollTop - element.clientHeight < 72;
		};
		const selecting = () => {
			if (pointerDown) return true;
			const selection = getSelection();
			return Boolean(selection && !selection.isCollapsed && selection.anchorNode && scroller.value?.contains(selection.anchorNode));
		};
		const interrupt = () => { followBottom = false; programmatic = false; };
		const snap = () => {
			if (snapFrame) return;
			snapFrame = requestAnimationFrame(() => {
				snapFrame = 0;
				if (!followBottom || selecting()) return;
				const element = scroller.value;
				if (element) element.scrollTo({ top: element.scrollHeight });
				jump.value = false;
			});
		};
		const toBottom = (smooth = false) => {
			followBottom = true;
			programmatic = smooth;
			scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: smooth ? "smooth" : "auto" });
			jump.value = false;
		};
		controller.scrollToBottom.value = toBottom;
		const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) interrupt(); };
		const onScrollKey = (event: KeyboardEvent) => {
			if (event.key === "PageUp" || event.key === "ArrowUp" || event.key === "Home" || (event.key === " " && event.shiftKey)) interrupt();
		};
		const onPointerDown = (event: PointerEvent) => {
			pointerDown = true;
			if (event.target === scroller.value) interrupt();
		};
		const onPointerUp = () => { pointerDown = false; };
		const observeThread = async () => {
			await nextTick();
			threadObserver?.disconnect();
			const element = scroller.value?.querySelector<HTMLElement>(".thread");
			if (!element) return;
			threadObserver = new ResizeObserver(() => {
				if (followBottom) snap();
				else if (!nearBottom()) jump.value = true;
			});
			threadObserver.observe(element);
		};
		// Typing with nothing focused goes to the prompt, as it would in a chat window.
		const typeToFocus = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || controller.overlays.current.value) return;
			const printable = (event.key.length === 1 && event.key !== " ") || event.key === "Process";
			if (!printable || (event.target as Element | null)?.closest?.("input, textarea, select, button, a, summary, [contenteditable], [tabindex]")) return;
			composer.focus({ preventScroll: true });
		};
		onMounted(() => {
			document.addEventListener("keydown", typeToFocus);
			const element = scroller.value;
			element?.addEventListener("wheel", onWheel, { passive: true });
			element?.addEventListener("touchmove", interrupt, { passive: true });
			element?.addEventListener("keydown", onScrollKey);
			element?.addEventListener("pointerdown", onPointerDown, { passive: true });
			window.addEventListener("pointerup", onPointerUp);
			window.addEventListener("pointercancel", onPointerUp);
			void observeThread();
			if (dock.value) {
				dockObserver = new ResizeObserver(([entry]) => {
					if (entry) document.documentElement.style.setProperty("--dock-height", `${entry.borderBoxSize[0]?.blockSize ?? dock.value!.offsetHeight}px`);
				});
				dockObserver.observe(dock.value);
			}
		});
		onBeforeUnmount(() => {
			document.removeEventListener("keydown", typeToFocus);
			const element = scroller.value;
			element?.removeEventListener("wheel", onWheel);
			element?.removeEventListener("touchmove", interrupt);
			element?.removeEventListener("keydown", onScrollKey);
			element?.removeEventListener("pointerdown", onPointerDown);
			window.removeEventListener("pointerup", onPointerUp);
			window.removeEventListener("pointercancel", onPointerUp);
			if (snapFrame) cancelAnimationFrame(snapFrame);
			dockObserver?.disconnect();
			threadObserver?.disconnect();
		});
		watch(store.conversationKey, async () => {
			await observeThread();
			if (store.id.value !== undefined) toBottom();
		});
		watch(store.transcript, async (_value, _previous, onCleanup) => {
			const stick = followBottom || nearBottom();
			const height = scroller.value?.scrollHeight ?? 0;
			let cancelled = false;
			onCleanup(() => { cancelled = true; });
			await nextTick();
			if (cancelled) return;
			if (stick) snap();
			else if ((scroller.value?.scrollHeight ?? 0) > height) jump.value = true;
		}, { flush: "pre" });
		return () => (
			<>
				<header class="topbar">
					<button class="icon-btn" id="chats-toggle" type="button" title={t("chat.list")} aria-label={t("chat.list")} ref={controller.chatsButton} onClick={() => controller.openChats()}><Icon name="menu" size={18} /></button>
					<h1 class="title" id="title" title={store.title.value || t("chat.untitled")}>{store.title.value || t("chat.untitled")}</h1>
					<button class="icon-btn" id="new-chat" type="button" title={t("chat.new")} aria-label={t("chat.new")} hidden={store.status.value === "new"}
						onClick={() => { void controller.open(undefined); composer.focus(); }}><Icon name="compose" size={18} /></button>
					<button class="icon-btn" id="files-toggle" type="button" title={t("files.title")} aria-label={t("files.title")} hidden={store.status.value === "new"}
						disabled={!controller.session.chat} ref={controller.filesButton} onClick={() => controller.openFiles()}><Icon name="folder" size={18} /></button>
					<button class="icon-btn" id="settings-toggle" type="button" title={t("settings.title")} aria-label={t("settings.title")} ref={controller.settingsButton} onClick={() => controller.openSettings()}><Icon name="sliders" size={18} /></button>
				</header>
				<main class="main">
					{store.reconnecting.value && <div class="banner" role="status"><span class="spinner" />{t("reconnecting")}</div>}
					<div class="scroller" id="scroller" ref={scroller} onScroll={() => {
						const element = scroller.value;
						if (element) {
							const gap = element.scrollHeight - element.scrollTop - element.clientHeight;
							if (gap <= 24) { followBottom = true; programmatic = false; jump.value = false; }
							else if (gap > 72 && !programmatic) followBottom = false;
						}
						document.body.toggleAttribute("data-scrolled", (scroller.value?.scrollTop ?? 0) > 2);
					}}>
						<Transcript controller={controller} key={store.conversationKey.value} />
					</div>
					<button class="jump" type="button" hidden={!jump.value} onClick={() => toBottom(true)}><Icon name="down" size={14} />{t("jump")}</button>
				</main>
				<footer class="composer-wrap" ref={dock}>
					<ApprovalBar controller={controller} /><MessageQueue controller={controller} /><Composer controller={controller} />
				</footer>
				<OverlayHost overlays={controller.overlays} />
			</>
		);
	},
});
