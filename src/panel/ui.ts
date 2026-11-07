// Small DOM helpers for the panel: `h()` builds elements (text always as text, never parsed as HTML), `icon()` the
// stroke icons, `logo()` the Oshawatt mark.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, string | number | boolean | null | undefined | ((event: never) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: (Child | Child[])[]) {
	const element = document.createElement(tag);
	for (const [name, value] of Object.entries(props ?? {})) {
		if (value === undefined || value === null || value === false) continue;
		if (typeof value === "function") element.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
		else if (name === "class") element.className = String(value);
		else element.setAttribute(name, value === true ? "" : String(value));
	}
	append(element, children);
	return element;
}

export function append(parent: Node, children: (Child | Child[])[]) {
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
	}
}

const SVG = "http://www.w3.org/2000/svg";

/** 24×24 stroke icons: path data, or a circle / rect as `c:cx,cy,r` / `r:x,y,w,h,rx`. */
const ICONS = {
	plus: ["M12 5v14", "M5 12h14"],
	compose: ["M12 20h8", "M15.5 4.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"],
	menu: ["M4 6.5h16", "M4 12h16", "M4 17.5h10"],
	sliders: ["M4 7h9", "M19 7h1", "M4 17h3", "M13 17h7", "c:16,7,2.5", "c:10,17,2.5"],
	send: ["M12 19V5.5", "M6 11l6-6 6 6"],
	stop: ["r:7,7,10,10,2"],
	chevron: ["m7 10 5 5 5-5"],
	back: ["m14.5 6-6 6 6 6"],
	check: ["m5 12.5 4.5 4.5L19 7.5"],
	x: ["M6.5 6.5l11 11", "M17.5 6.5l-11 11"],
	copy: ["r:9,9,11,11,2", "M15 5V4.5A1.5 1.5 0 0 0 13.5 3h-9A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15H5"],
	eye: ["M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z", "c:12,12,3"],
	pointer: ["M5.5 3.5 19 10l-6 1.8-2.2 6.2Z", "m13 12 5.5 5.5"],
	keyboard: ["r:2.5,6,19,12,2.5", "M6.5 10h1", "M10.5 10h1", "M14.5 10h1", "M7 14h10"],
	scroll: ["M12 3.5v17", "m8 7.5 4-4 4 4", "m8 16.5 4 4 4-4"],
	tabs: ["M3 8.5 12 4l9 4.5-9 4.5Z", "m3 13 9 4.5 9-4.5", "m3 17 9 4.5 9-4.5"],
	external: ["M14 4h6v6", "M20 4l-8.5 8.5", "M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"],
	code: ["m8 8-4 4 4 4", "m16 8 4 4-4 4", "m13.5 5-3 14"],
	alert: ["c:12,12,9", "M12 7.5v5.5", "M12 16.5v.01"],
	globe: ["c:12,12,9", "M3 12h18", "M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"],
	lock: ["r:5,11,14,10,2", "M8 11V8a4 4 0 0 1 8 0v3"],
	key: ["c:8,15.5,4", "m11 12.5 8.5-8.5", "m16.5 7 2.5 2.5"],
	trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7", "M9 7V4.5h6V7"],
	bulb: ["M9 18h6", "M10 21h4", "M12 3a6 6 0 0 0-3.8 10.6c.6.5.8 1.2.8 1.9V16h6v-.5c0-.7.2-1.4.8-1.9A6 6 0 0 0 12 3Z"],
	down: ["M12 5v14", "m6 13 6 6 6-6"],
	tool: ["M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z"],
	spark: ["M12 3.5 13.8 10 20.5 12l-6.7 2-1.8 6.5-1.8-6.5L3.5 12l6.7-2Z"],
	list: ["M9 6.5h11", "M9 12h11", "M9 17.5h11", "M4.5 6.5h.01", "M4.5 12h.01", "M4.5 17.5h.01"],
	form: ["r:4,4,16,16,2.5", "M8 9h8", "M8 13h8", "M8 17h4"],
	file: ["M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z", "M14 3v6h6", "M8 13h8", "M8 17h5"],
	folder: ["M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"],
	download: ["M12 3v12", "m7 10 5 5 5-5", "M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"],
	refresh: ["M20 11a8 8 0 0 0-14-5", "M4 13a8 8 0 0 0 14 5", "M20 4v7h-7", "M4 20v-7h7"],
	sun: ["c:12,12,4", "M12 2.5v2", "M12 19.5v2", "M2.5 12h2", "M19.5 12h2", "m5.3 5.3 1.4 1.4", "m17.3 17.3 1.4 1.4", "m5.3 18.7 1.4-1.4", "m17.3 6.7 1.4-1.4"],
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): SVGSVGElement {
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("icon");
	for (const shape of ICONS[name]) {
		let node: SVGElement;
		if (shape.startsWith("c:")) {
			const [cx, cy, r] = shape.slice(2).split(",");
			node = document.createElementNS(SVG, "circle");
			node.setAttribute("cx", cx!);
			node.setAttribute("cy", cy!);
			node.setAttribute("r", r!);
		} else if (shape.startsWith("r:")) {
			const [x, y, w, hgt, rx] = shape.slice(2).split(",");
			node = document.createElementNS(SVG, "rect");
			for (const [k, v] of [["x", x], ["y", y], ["width", w], ["height", hgt], ["rx", rx]] as const) node.setAttribute(k, v!);
		} else {
			node = document.createElementNS(SVG, "path");
			node.setAttribute("d", shape);
		}
		svg.appendChild(node);
	}
	return svg;
}

let logoCount = 0;

/** The Oshawatt mark: a drop of water with a wave across it. */
export function logo(size = 24): SVGSVGElement {
	const id = `oshawatt-logo-${logoCount++}`;
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", "0 0 32 32");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("aria-hidden", "true");
	svg.classList.add("logo");
	const defs = document.createElementNS(SVG, "defs");
	const gradient = document.createElementNS(SVG, "linearGradient");
	gradient.id = id;
	for (const [k, v] of [["x1", "0.2"], ["y1", "0"], ["x2", "0.8"], ["y2", "1"]]) gradient.setAttribute(k!, v!);
	for (const [offset, color] of [["0", "#62d0f5"], ["1", "#2a64e0"]]) {
		const stop = document.createElementNS(SVG, "stop");
		stop.setAttribute("offset", offset!);
		stop.setAttribute("stop-color", color!);
		gradient.appendChild(stop);
	}
	defs.appendChild(gradient);
	const drop = document.createElementNS(SVG, "path");
	drop.setAttribute("d", "M16 2.5c5.6 6.6 9.5 11.6 9.5 16.6a9.5 9.5 0 0 1-19 0c0-5 3.9-10 9.5-16.6Z");
	drop.setAttribute("fill", `url(#${id})`);
	const wave = document.createElementNS(SVG, "path");
	wave.setAttribute("d", "M10.2 20.2c1.9 1.7 3.9 1.7 5.8 0s3.9-1.7 5.8 0");
	wave.setAttribute("fill", "none");
	wave.setAttribute("stroke", "#fff");
	wave.setAttribute("stroke-width", "2.2");
	wave.setAttribute("stroke-linecap", "round");
	const shine = document.createElementNS(SVG, "path");
	shine.setAttribute("d", "M12.3 13.6c.6-1.6 1.6-3.1 2.7-4.5");
	shine.setAttribute("fill", "none");
	shine.setAttribute("stroke", "rgba(255,255,255,.55)");
	shine.setAttribute("stroke-width", "1.8");
	shine.setAttribute("stroke-linecap", "round");
	svg.append(defs, drop, wave, shine);
	return svg;
}

/** A transient message at the bottom of the panel. */
export function toast(text: string, tone: "info" | "error" = "info") {
	const node = h("div", { class: "toast", "data-tone": tone, role: "status" }, text);
	document.body.appendChild(node);
	setTimeout(() => node.classList.add("leaving"), 1800);
	setTimeout(() => node.remove(), 2100);
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
