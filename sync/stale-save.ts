/**
 * A stale save, refused (Boss's walk D1 claim 1). A save
 * sends the change_seq its note was last pulled or saved at as `If-Match`
 * (vault/change-seq-index.ts); when another writer changed the element since,
 * keel answers 412 and writes nothing, and the plugin writes nothing either:
 * no retry, no merge, no re-pull. The person's edit stays in the note.
 *
 * Download replaces a changed element's fields in its note, so the notice says
 * to keep a copy of the edit before running it.
 */

/** Save element and auto-sync: the one notice for a note pulled before someone else's change. */
export function staleSaveMessage(category: string, label: string): string {
	return `${category} "${label}" changed on onlyworlds.com since this note was pulled, so nothing was saved. ` +
		"Your edit is still in the note. Download world brings the current copy and replaces the note's fields: copy your edit first to keep it.";
}

/**
 * The first save of a note with no recorded change_seq (a vault from before
 * 3.8.1): sent without If-Match, so a newer change on onlyworlds.com was not
 * checked for; said once per element (Seethe's walk, 2026-10-22).
 */
export function unguardedSaveMessage(category: string, label: string): string {
	return `This note had no recorded version from onlyworlds.com, so ${category} "${label}" was saved without checking for newer changes there. ` +
		"From now on its saves are checked.";
}

/** Delete element: the element changed since the note was pulled, so it was not deleted. */
export function staleDeleteMessage(category: string, label: string): string {
	return `${category} "${label}" changed on onlyworlds.com since this note was pulled, so it was not deleted. ` +
		"Download world brings the current copy.";
}

/** Upload world: the notes not sent because their elements changed on onlyworlds.com since they were pulled. */
export function staleUploadMessage(names: string[]): string {
	const shown = names.slice(0, 3).join(", ");
	const more = names.length > 3 ? ` +${names.length - 3} more` : "";
	const one = names.length === 1;
	return `Not sent, changed on onlyworlds.com since ${one ? "its note was" : "their notes were"} pulled: ${shown}${more}. ` +
		`Your edits are still in ${one ? "the note" : "the notes"}. Download world brings the current copies and replaces those notes' fields: copy your edits first to keep them.`;
}
