/**
 * The note mark: PURE logic, NO Obsidian imports (unit-tested under `npm test`).
 *
 * A pull replaces the fields of a changed element's note, so a person's edit that was never
 * saved would go with them. To tell such a note, the change_seq index (`.ow-seq.json`) keeps one
 * more number beside an id's change_seq and its `^` mark: `<id>#`, a hash of the note's bytes as
 * the last pull or save left them. A note whose bytes no longer hash to it holds edits that were
 * not saved, and a pull leaves it as it is and says so. No entry (a vault from before, a note an
 * upload just sent, a save that could not tell) means no claim either way: the pull writes it as
 * it always did.
 *
 * The hash is cyrb53 (a non-cryptographic 53-bit hash): the index holds whole numbers only, and
 * a collision costs one note written over, which is today's behaviour.
 */

/** The index key of an id's note mark. */
export function markKey(id: string): string {
	return `${id}#`;
}

/** The mark of a note's bytes: a whole number below 2^53. */
export function noteMark(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** True when the note holds edits no pull or save has seen: a mark is recorded and the bytes no longer match it. */
export function holdsUnsavedEdits(text: string, recorded: number | undefined | null): boolean {
	return typeof recorded === "number" && noteMark(text) !== recorded;
}

/** The one notice of a pull that left notes alone. `names` are the notes' labels. */
export function keptEditedMessage(names: string[]): string {
	const shown = names.slice(0, 3).join(", ");
	const more = names.length > 3 ? ` +${names.length - 3} more` : "";
	const one = names.length === 1;
	return `Download kept ${names.length} note${one ? "" : "s"} with unsaved edits as ${one ? "it is" : "they are"}: ${shown}${more}. ` +
		`The world changed them too, so Save would be refused: copy the edits out and delete ${one ? "the note" : "the notes"}, then Download world again brings the world's copy.`;
}
