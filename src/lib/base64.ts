const CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
	const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
	if (native) return native.call(bytes);
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
	const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array }).fromBase64;
	if (native) return native(text);
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
