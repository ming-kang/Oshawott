export async function until(what, read, ms = 15_000) {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read().catch(() => undefined);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`Timed out: ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

export function checklist() {
	const failures = [];
	return {
		step(name, ok, detail = "") {
			if (!ok) failures.push(name);
			console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
		},
		get failed() {
			return failures.length > 0;
		},
		finish() {
			if (!failures.length) return;
			console.error(`${failures.length} step(s) failed`);
			process.exit(1);
		},
	};
}
