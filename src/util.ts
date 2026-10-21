export function truncateAndPad(text: string, len: number, char = " "): string {
	if (len === 0) {
		return "";
	}
	// If longer than max len, truncate right after first non-space char
	if (text.length > len) {
		// i is position of ellipses
		let i = len - 1;
		while (i > 0 && text[i - 1] === " ") {
			i--;
		}
		text = `${text.slice(0, i)}…`;
	}
	return text.padEnd(len, char);
}
