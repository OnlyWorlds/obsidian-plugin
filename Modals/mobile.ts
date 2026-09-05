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
 * Three causes compounded, and this helper answers all three:
 *
 *   1. Nothing capped modal height or scrolled the overflow, so a tall modal
 *      simply extended past the viewport. -> `ow-mobile-modal` caps the modal
 *      at the VISIBLE viewport and makes the content area the scroller.
 *   2. 14 of 24 modals auto-focused a text input, summoning the keyboard before
 *      the user had seen the dialog. -> `suppressAutofocus()` skips that
 *      focus call on phones (tablets keep it; there is room there).
 *   3. Buttons were built last in content flow, so they were the first thing
 *      the keyboard covered. -> the button row is promoted to a sticky footer
 *      that stays reachable while the content above it scrolls.
 *
 * WHY VISUAL VIEWPORT: on iOS the on-screen keyboard does NOT shrink the layout
 * viewport, so `100vh` still spans the full screen and the sticky footer lands
 * underneath the keyboard. `window.visualViewport.height` is the only measure
 * that reflects the space actually visible, so we track it and write it to a
 * CSS custom property the stylesheet consumes.
 *
 * Desktop is untouched: every function here returns immediately unless
 * `Platform.isMobile` is true.
 */

/** Marks a modal for the mobile stylesheet and keeps it inside the visible viewport. */
export function applyMobileModal(modal: Modal): void {
	if (!Platform.isMobile) return;

	modal.modalEl.addClass('ow-mobile-modal');
	promoteButtonRowToFooter(modal);
	trackVisualViewport(modal);
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
 * Writes the visible viewport height into `--ow-viewport-height` on the modal.
 *
 * The keyboard opening/closing fires `resize` on visualViewport; without this
 * the modal keeps sizing itself against a viewport that the keyboard is
 * covering. Falls back to `100vh` (via the CSS default) where visualViewport is
 * unavailable, which costs nothing on platforms that shrink the layout viewport.
 */
function trackVisualViewport(modal: Modal): void {
	const vv = window.visualViewport;
	if (!vv) return;

	const sync = () => {
		modal.modalEl.style.setProperty('--ow-viewport-height', `${vv.height}px`);
	};

	sync();
	vv.addEventListener('resize', sync);
	vv.addEventListener('scroll', sync);

	// Obsidian empties contentEl on close; detach here so the listener does not
	// outlive the modal it was measuring for.
	const originalOnClose = modal.onClose.bind(modal);
	modal.onClose = () => {
		vv.removeEventListener('resize', sync);
		vv.removeEventListener('scroll', sync);
		originalOnClose();
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
