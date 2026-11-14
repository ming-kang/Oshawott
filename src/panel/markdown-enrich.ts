// Heavy blocks yield between jobs. Plain text is already visible; enrichment never paces the answer.
const jobs = new Set<() => void>();
let frame: number | undefined;

function flush() {
	frame = undefined;
	const start = performance.now();
	for (const job of jobs) {
		jobs.delete(job);
		job();
		if (performance.now() - start >= 6) break;
	}
	if (jobs.size) frame = requestAnimationFrame(flush);
}

export function enrich(job: () => void): () => void {
	jobs.add(job);
	frame ??= requestAnimationFrame(flush);
	return () => {
		jobs.delete(job);
		if (!jobs.size && frame !== undefined) {
			cancelAnimationFrame(frame);
			frame = undefined;
		}
	};
}
