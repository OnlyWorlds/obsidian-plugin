/**
 * The pure decision core behind the mobile modal fix — no Obsidian import, so
 * it is testable in plain node (same split as `vault/world-key-core.ts`).
 *
 * The DOM half lives in `Modals/mobile.ts`.
 */

/** What one direct child of `contentEl` looks like, for footer selection. */
export interface RowShape {
	/** True when the element IS a <button> (not merely contains one). */
	isButton: boolean;
	/** Buttons contained within (0 for a bare button — see isButton). */
	buttons: number;
	inputs: number;
	/** Descendants that are not buttons and not inside a button. */
	otherContent: number;
}

/**
 * Picks the trailing run of action elements to lift into a sticky footer.
 * Returns [startIndex, endIndex] inclusive, or null when there is nothing to lift.
 *
 * ⚑ WHY A RUN AND NOT A ROW — the thing I got wrong first, caught by reading the
 * modals instead of trusting the tests I had written from assumption:
 * **11 of the 24 modals create their buttons as BARE DIRECT CHILDREN of
 * contentEl, not inside a container.** CreateElementFromLinkModal has Cancel and
 * Create as two separate siblings; CreateWorldModal has a three-button container
 * AND, when local worlds exist, a further bare TAKE ONLINE button after it.
 * A rule that looks for "the row of buttons" finds a container in 10 modals and
 * a single stray button in the rest — pinning one button and leaving its
 * siblings behind the keyboard, which is the original bug with extra steps.
 *
 * So the rule scans BACKWARDS from the end over everything that is an action
 * (a bare button, or a container that is essentially just buttons) and returns
 * the whole trailing run. The caller wraps that run in one footer element.
 *
 * Stops at the first non-action element, so prose and fields stay in the
 * scrolling body. Returns null when the modal's last element is not an action
 * (the report modals), leaving those to scroll as a whole — correct for them.
 */
export function findFooterRun(rows: RowShape[]): [number, number] | null {
	const end = rows.length - 1;
	if (end < 0 || !isActionElement(rows[end])) return null;

	let start = end;
	while (start - 1 >= 0 && isActionElement(rows[start - 1])) start--;

	// Everything is an action and nothing would be left to scroll — leave the
	// modal alone rather than pinning the whole of it as a footer.
	if (start === 0) return null;

	return [start, end];
}

/** A bare button, or a container holding buttons and little else. */
function isActionElement(row: RowShape): boolean {
	if (row.isButton) return true;
	if (row.buttons === 0) return false;
	// A row holding an input is a field row; pinning it would put the very thing
	// the keyboard covers into the footer.
	if (row.inputs > 0) return false;
	// Content beyond the buttons themselves means this is a list or a body
	// section that happens to contain a button — not an action row. The live
	// case is ElementSelectionModal's element list: Setting rows each carrying
	// a Set/Linked button, with no Done footer in the single-link variant.
	// Promoting that list would pin the whole list to the bottom of the screen.
	return row.otherContent <= row.buttons;
}
