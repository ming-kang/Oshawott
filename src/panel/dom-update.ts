/** Insert only changed positions; unchanged controls keep focus and browser-owned state. */
export function reconcileChildren(parent: Node, children: readonly Node[]) {
	for (let i = 0; i < children.length; i++) {
		const child = children[i]!;
		if (parent.childNodes[i] !== child) parent.insertBefore(child, parent.childNodes[i] ?? null);
	}
	while (parent.childNodes.length > children.length) parent.removeChild(parent.lastChild!);
}

/** Keep unchanged text (and a selection inside it) intact, including while appending a stream. */
export function updateText(node: Text, value: string) {
	const before = node.data;
	if (before === value) return;
	let start = 0;
	while (start < before.length && start < value.length && before[start] === value[start]) start++;
	let end = 0;
	while (end < before.length - start && end < value.length - start && before[before.length - end - 1] === value[value.length - end - 1]) end++;
	node.replaceData(start, before.length - start - end, value.slice(start, value.length - end));
}

/** Morph highlighter-generated spans, without replacing the scrolling code container. */
export function patchHighlighted(parent: Node, fresh: readonly Node[]) {
	for (let i = 0; i < fresh.length; i++) {
		const next = fresh[i]!;
		const old = parent.childNodes[i];
		if (old instanceof Text && next instanceof Text) updateText(old, next.data);
		else if (old instanceof HTMLSpanElement && next instanceof HTMLSpanElement) {
			if (old.className !== next.className) old.className = next.className;
			patchHighlighted(old, [...next.childNodes]);
		} else if (old) parent.replaceChild(next, old);
		else parent.appendChild(next);
	}
	while (parent.childNodes.length > fresh.length) parent.removeChild(parent.lastChild!);
}
