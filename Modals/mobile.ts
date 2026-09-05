import { Modal, Platform } from 'obsidian';
import { findFooterRun, RowShape } from './mobile-core';

/**
 * Mobile modal adaptation — one call per modal, at the END of onOpen().
 *
 * THE BUG THIS EXISTS FOR (reported by a user on iOS, 2026-09-05):
 * modal dialogs render centered and unscrollable, so the action buttons at the
 * bottom sit behind the on-screen keyboard — which on iOS cannot be dismissed
 * from inside a modal. The dialog becomes unusable: you can type, but you can
 * never reach CREATE or CANCEL.
 *
 * Four causes, and this helper plus `styles.css` answer all four:
 *
 *   1. Nothing capped modal height or scrolled the overflow, so a tall modal
 *      simply extended past the viewport. -> the stylesheet sets obsidian's own
 *      `--modal-max-height` in `dvh` and makes the content area the scroller.
 *   2. 14 of 24 modals auto-focused a text input, summoning the keyboard before
 *      the user had seen the dialog. -> `suppressAutofocus()` skips that
 *      focus call on phones (tablets keep it; there is room there).
 *   3. Buttons were built last in content flow, so they were the first thing
 *      the keyboard covered. -> the button row is promoted to a sticky footer.
 *   4. ★ There was NO WAY TO DISMISS THE KEYBOARD (confirmed on device: a tap
 *      elsewhere in the modal does nothing; only a tap far enough outside
 *      closes the whole dialog, losing the input). -> `addKeyboardDismissal()`
 *      blurs the focused field on a tap anywhere in the modal's own chrome.
 *
 * ⚑ WHY THERE IS NO visualViewport CODE HERE ANY MORE. 3.2.2 measured
 * `window.visualViewport.height` and wrote it into a custom property. It
 * shipped, and on a real iPhone the modal rendered correctly and STILL did not
 * shrink for the keyboard. The height is now `100dvh` in CSS instead — the
 * browser owns it, there is no listener to fail to fire, and nothing to
 * measure wrong. Do not reintroduce the JS measurement; it was tried.
 *
 * Desktop is untouched: every function here returns immediately unless
 * `Platform.isMobile` is true.
 */

/** Marks a modal for the mobile stylesheet and makes its keyboard escapable. */
export function applyMobileModal(modal: Modal): void {
	if (!Platform.isMobile) return;

	modal.modalEl.addClass('ow-mobile-modal');
	promoteButtonRowToFooter(modal);
	addKeyboardDismissal(modal);
}

/**
 * ★ Gives the keyboard a way out.
 *
 * On iOS, inside a modal, there is no system affordance to close the keyboard:
 * no back gesture (that is android), no "Done" bar, and tapping the modal's own
 * background does nothing because nothing was listening. The user's only escape
 * was tapping outside the modal entirely, which closes the dialog and discards
 * what they typed. Confirmed on device 2026-09-05.
 *
 * So: a tap on the modal's own chrome — anywhere that is not itself an input or
 * a button — blurs the active field, which is what closes the keyboard. Tapping
 * a heading, a label, a description paragraph or the padding now works the way
 * a user expects, and nothing else changes.
 *
 * `pointerdown` rather than `click`: it fires before focus moves, so the blur
 * lands even when the tap target is not focusable.
 */
function addKeyboardDismissal(modal: Modal): void {
	modal.modalEl.addEventListener('pointerdown', (evt: PointerEvent) => {
		const target = evt.target as HTMLElement | null;
		if (!target) return;
		// A tap ON a control is that control's business — never steal its focus.
		if (target.closest('input, textarea, select, button, a, [contenteditable]')) return;

		const active = document.activeElement;
		if (active instanceof HTMLElement && modal.modalEl.contains(active)) {
			active.blur();
		}
	});
}

/**
 * Lifts the modal's trailing action elements into one sticky footer.
 *
 * Covers every idiom in this plugin: a hand-built flex `div` of buttons, a
 * bare `<button>` created straight onto contentEl (11 of the 24 modals do
 * this), several such buttons in a row, and Obsidian's own `Setting` row
 * carrying only buttons. The run is WRAPPED in a new element rather than
 * tagged, because in most of these modals there is no single row to tag.
 */
function promoteButtonRowToFooter(modal: Modal): void {
	const content = modal.contentEl;
	const children = Array.from(content.children) as HTMLElement[];
	const run = findFooterRun(children.map(describeRow));
	if (!run) return;

	const [start, end] = run;
	const footer = content.createDiv({ cls: 'ow-mobile-modal-footer' });
	// createDiv appends; move it into place before the run, then fill it. The
	// buttons keep their listeners — appendChild moves nodes, it does not clone.
	content.insertBefore(footer, children[start]);
	for (let i = start; i <= end; i++) footer.appendChild(children[i]);
}

function describeRow(el: HTMLElement): RowShape {
	const buttons = el.querySelectorAll('button').length;
	return {
		isButton: el instanceof HTMLButtonElement,
		buttons,
		inputs: el.querySelectorAll('input, textarea, select').length,
		otherContent: Array.from(el.querySelectorAll('*')).filter(
			(n) => !(n instanceof HTMLButtonElement) && !n.closest('button')
		).length,
	};
}

/**
 * True when a modal should NOT auto-focus its first input.
 *
 * On a phone, focusing an input opens the keyboard immediately — before the
 * user has read the dialog — and on iOS it cannot be dismissed from within a
 * modal. Tablets and desktop keep auto-focus, where it is a convenience rather
 * than a trap.
 *
 * Usage at each existing focus call:
 *   if (!suppressAutofocus()) nameInput.focus();
 */
export function suppressAutofocus(): boolean {
	return Platform.isPhone;
}
