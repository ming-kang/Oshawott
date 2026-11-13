export const control = <T extends HTMLElement>(selector: string): T | null =>
	document.querySelector<T>(`.overlay:not(.leaving) ${selector}`) ?? document.querySelector<T>(selector);

export function click(selector: string) {
	const element = control<HTMLElement>(selector);
	if (!element) throw new Error(`No panel control ${selector}`);
	element.click();
}

export function input(selector: string, value: string) {
	const element = control<HTMLInputElement>(selector);
	if (!element) throw new Error(`No panel input ${selector}`);
	element.value = value;
	element.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function until<T>(read: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 10_000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (value) return value;
		if (Date.now() >= deadline) throw new Error("panel control did not settle");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
