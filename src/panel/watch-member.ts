import type { WatchHandle } from "@earendil-works/chord";

export function watchMember<T>(watch: WatchHandle<T>, update: (value: T) => void | Promise<void>) {
	void update(watch.value);
	watch.start(async (call) => {
		if (call.kind === "value") await update(call.value);
	});
}
