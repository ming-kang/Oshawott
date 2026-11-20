import { computed, shallowRef } from "vue";
import type { AttachmentInput } from "../lib/attachments.ts";
import { AttachmentPicker, pendingInput } from "./attachments.ts";
import type { ComposerDraft } from "./drafts.ts";
import type { DraftSource } from "./draft-session.ts";

export class ComposerState implements DraftSource {
	readonly #text = shallowRef("");
	readonly #revision = shallowRef(0);
	readonly prompt = shallowRef<HTMLTextAreaElement>();
	readonly modelButton = shallowRef<HTMLButtonElement>();
	readonly thinkingButton = shallowRef<HTMLButtonElement>();
	readonly stopButton = shallowRef<HTMLButtonElement>();
	readonly sendButton = shallowRef<HTMLButtonElement>();
	readonly dock = shallowRef<HTMLElement>();
	readonly attachments: AttachmentPicker;
	readonly hasContent = computed(() => Boolean(this.text.trim() || this.attachments.items.length));

	constructor(onChange: () => void) {
		this.attachments = new AttachmentPicker(() => {
			this.#revision.value++;
			onChange();
		});
		this.onChange = onChange;
	}

	private readonly onChange: () => void;

	get text() { return this.#text.value; }
	set text(value: string) { this.#text.value = value; }
	get revision() { return this.#revision.value; }

	editText(value: string) {
		this.#text.value = value;
		this.#revision.value++;
		this.onChange();
	}

	pending(): AttachmentInput[] {
		return this.attachments.items.map(pendingInput);
	}

	draft(): ComposerDraft {
		return { text: this.text, attachments: this.pending(), updatedAt: Date.now() };
	}

	restore(draft: ComposerDraft | undefined) {
		this.text = draft?.text ?? "";
		this.attachments.restore(draft?.attachments ?? []);
	}

	reset() {
		this.#revision.value++;
		this.text = "";
		this.attachments.clear();
	}

	clearText() {
		this.text = "";
		this.#revision.value++;
	}

	focus(options?: FocusOptions) { this.prompt.value?.focus(options); }

	/** Inserts text at the caret (or the end when the prompt isn't focused), padded by spaces as needed. */
	insertText(text: string) {
		const prompt = this.prompt.value;
		const focused = prompt && document.activeElement === prompt;
		const start = focused ? prompt.selectionStart : this.text.length;
		const end = focused ? prompt.selectionEnd : start;
		const before = this.text.slice(0, start);
		const after = this.text.slice(end);
		const insert = `${before && !/\s$/.test(before) ? " " : ""}${text}${after && !/^\s/.test(after) ? " " : ""}`;
		this.editText(before + insert + after);
		const caret = (before + insert).length;
		prompt?.focus({ preventScroll: true });
		prompt?.setSelectionRange(caret, caret);
	}

	resize() {
		const prompt = this.prompt.value;
		if (!prompt) return;
		prompt.style.height = "auto";
		prompt.style.height = `${Math.min(prompt.scrollHeight, Math.round(innerHeight * 0.4))}px`;
	}
}
