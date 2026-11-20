import { shallowRef } from "vue";
import { ext } from "../platform/webext.ts";

export class SiteAccess {
	readonly granted = shallowRef(true);
	readonly error = shallowRef(false);
	readonly requesting = shallowRef(false);
	#started = false;
	#revision = 0;

	#refresh = () => {
		const revision = ++this.#revision;
		void ext.permissions.contains({ origins: ["<all_urls>"] }).then((granted) => {
			if (this.#started && revision === this.#revision) this.granted.value = granted;
		}).catch(() => {
			if (this.#started && revision === this.#revision) this.error.value = true;
		});
	};

	start() {
		if (this.#started) return;
		this.#started = true;
		ext.permissions.onAdded.addListener(this.#refresh);
		ext.permissions.onRemoved.addListener(this.#refresh);
		this.#refresh();
	}

	stop() {
		this.#started = false;
		this.#revision++;
		ext.permissions.onAdded.removeListener(this.#refresh);
		ext.permissions.onRemoved.removeListener(this.#refresh);
	}

	request() {
		const pending = ext.permissions.request({ origins: ["<all_urls>"] });
		this.#revision++;
		this.requesting.value = true;
		this.error.value = false;
		void pending.then((granted) => {
			this.granted.value = granted;
		}).catch(() => {
			this.error.value = true;
		}).finally(() => {
			this.requesting.value = false;
		});
	}
}
