/**
 * Mobile modal footer selection — the pure decision core (findFooterRun).
 *
 * Context: a user reported (iOS, 2026-09-05) that modal buttons sit behind the
 * on-screen keyboard, unreachable. The fix lifts the trailing action elements
 * into a sticky footer, which means something has to DECIDE which elements
 * those are.
 *
 * ⚑ Every case below is transcribed from the modal's actual build order in
 * source, NOT from an idea of what a modal looks like. The first version of
 * this file was written from assumption and encoded a shape no modal has —
 * it modelled buttons as always living in a container, when 11 of the 24
 * create them as bare children of contentEl. Reading the modals is what found
 * that; the tests had all passed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findFooterRun, RowShape } from "../Modals/mobile-core";

/** A bare <button> child — the majority idiom in this plugin. */
const bareButton = (): RowShape => ({ isButton: true, buttons: 0, inputs: 0, otherContent: 0 });
/** A container holding N buttons and nothing else (`buttonContainer`). */
const buttonBox = (n: number): RowShape => ({ isButton: false, buttons: n, inputs: 0, otherContent: 0 });
/** A bare <input> / <label> / <p> / <h3> child. */
const input = (): RowShape => ({ isButton: false, buttons: 0, inputs: 1, otherContent: 0 });
const prose = (): RowShape => ({ isButton: false, buttons: 0, inputs: 0, otherContent: 0 });

test("CreateWorldModal (no local worlds): lifts the 3-button container", () => {
	// h3, label, input, label, input, label, input, p, buttonContainer(3)
	const rows = [prose(), prose(), input(), prose(), input(), prose(), input(), prose(), buttonBox(3)];
	assert.deepEqual(findFooterRun(rows), [8, 8]);
});

test("★ CreateWorldModal (local worlds present): the bare TAKE ONLINE button joins the footer", () => {
	// ...buttonContainer(3), hr, label, p, select, button — the select BREAKS the
	// run, so only the trailing bare button lifts. The container above it stays
	// in the body. This is the case the first implementation got wrong.
	const rows = [
		prose(), prose(), input(), prose(), input(), prose(), input(), prose(),
		buttonBox(3), prose(), prose(), prose(), input(), bareButton(),
	];
	assert.deepEqual(findFooterRun(rows), [13, 13]);
});

test("★ CreateElementFromLinkModal: two BARE sibling buttons lift as one run", () => {
	// The cancel and create buttons are separate direct children of contentEl.
	// A 'find the button row' rule pins one and leaves the other behind glass.
	const rows = [prose(), input(), input(), bareButton(), bareButton()];
	assert.deepEqual(findFooterRun(rows), [3, 4]);
});

test("WorldKeyModal: a single bare button lifts", () => {
	const rows = [prose(), input(), bareButton()];
	assert.deepEqual(findFooterRun(rows), [2, 2]);
});

test("★ ElementSelectionModal single-link: a button-bearing LIST is never lifted", () => {
	// header (a '+' button plus a heading), search input, then the element list:
	// a div of Setting rows each carrying name + desc + a 'Set' button. No Done
	// footer in the single-link variant. Lifting the list would pin the whole
	// element list to the bottom of the screen and leave nothing scrolling.
	const header: RowShape = { isButton: false, buttons: 1, inputs: 0, otherContent: 2 };
	const list: RowShape = { isButton: false, buttons: 12, inputs: 0, otherContent: 36 };
	assert.equal(findFooterRun([header, input(), list]), null);
});

test("ElementSelectionModal multi-link: lifts Done, leaving the list scrolling", () => {
	const header: RowShape = { isButton: false, buttons: 1, inputs: 0, otherContent: 2 };
	const list: RowShape = { isButton: false, buttons: 12, inputs: 0, otherContent: 36 };
	const done = buttonBox(1);
	assert.deepEqual(findFooterRun([header, input(), list, done]), [3, 3]);
});

test("WorldPasteModal: textarea then a bare submit button — only the button lifts", () => {
	const rows = [prose(), input(), bareButton()];
	assert.deepEqual(findFooterRun(rows), [2, 2]);
});

test("★ a container holding an input AND a button is not lifted", () => {
	// Obsidian's Setting rows put a text field and its action button in one row
	// (PinInputModal, WorldRenameModal build this way). Lifting it would pin the
	// input into the footer — the exact element the keyboard needs room for —
	// and the modal would have no scrolling body left.
	const settingRow: RowShape = { isButton: false, buttons: 1, inputs: 1, otherContent: 0 };
	assert.equal(findFooterRun([prose(), settingRow]), null);
});

test("★ the run stops AT a field row rather than swallowing it", () => {
	// prose, setting-row-with-input, bare button -> only the button lifts.
	const settingRow: RowShape = { isButton: false, buttons: 1, inputs: 1, otherContent: 0 };
	assert.deepEqual(findFooterRun([prose(), settingRow, bareButton()]), [2, 2]);
});

test("a report modal ending in prose is left alone", () => {
	assert.equal(findFooterRun([prose(), prose(), prose()]), null);
});

test("ValidateResultModal: prose then a bare close button", () => {
	assert.deepEqual(findFooterRun([prose(), prose(), bareButton()]), [2, 2]);
});

test("no children at all", () => {
	assert.equal(findFooterRun([]), null);
});

test("a modal that is ONLY buttons is left alone — nothing would scroll", () => {
	assert.equal(findFooterRun([bareButton(), bareButton()]), null);
});

test("the run stops at the first non-action going up", () => {
	// prose, button, prose, button, button -> only the trailing pair lifts.
	const rows = [prose(), bareButton(), prose(), bareButton(), bareButton()];
	assert.deepEqual(findFooterRun(rows), [3, 4]);
});
