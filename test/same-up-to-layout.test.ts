/**
 * sameUpToLayout (vault/note-mark-core.ts): two notes are one but for layout when the front matter is the same byte for byte and
 * the body differs only in blank lines, trailing spaces and line endings. It must say no to every difference that carries a character.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sameUpToLayout } from "../vault/note-mark-core";

const note = (fm: string, body: string) => `---\n${fm}---\n${body}`;
const EMPTY = "\n### Description\n\nA noble.\n\n### Physicality\n\n\n### Mentality\n\n\n";

test("text typed on the blank line under an empty heading is layout", () => {
	const rendered = note("name: Ireena\nid: 1\n", EMPTY);
	const typed = note("name: Ireena\nid: 1\n", "\n### Description\n\nA noble.\n\n### Physicality\nTall.\n\n### Mentality\n\n\n");
	assert.equal(sameUpToLayout(rendered, typed), false, "the typed text is a non-blank line the render lacks");
	const rendered2 = note("name: Ireena\nid: 1\n", "\n### Description\n\nA noble.\n\n### Physicality\n\nTall.\n\n### Mentality\n\n\n");
	assert.equal(sameUpToLayout(rendered2, typed), true, "the same words with one blank line fewer");
});

test("blank lines, trailing spaces and CRLF are layout", () => {
	const a = note("name: Ireena\nid: 1\n", "\n### Description\n\nA noble.\n");
	assert.equal(sameUpToLayout(a, a.replace(/\n/g, "\r\n")), true);
	assert.equal(sameUpToLayout(a, a.replace("A noble.\n", "A noble.   \n\n\n")), true);
	assert.equal(sameUpToLayout(a, a.replace("\n### Description\n\n", "### Description\n")), true);
});

test("★ a difference in a front matter line is never layout", () => {
	const a = note("name: Ireena\nid: 1\ncourage: 62\n", "\n### Description\n\nA noble.\n");
	assert.equal(sameUpToLayout(a, a.replace("62", "62.5")), false);
	assert.equal(sameUpToLayout(a, a.replace("courage: 62\n", "")), false);
	assert.equal(sameUpToLayout(a, a.replace("name: Ireena\nid: 1\n", "id: 1\nname: Ireena\n")), false, "the order of lines");
	assert.equal(sameUpToLayout(a, a.replace("courage: 62\n", "courage: 62\n\n")), false, "a blank line inside the block");
});

test("★ a difference in a non-blank body line, a heading, or the order of lines is never layout", () => {
	const a = note("name: Ireena\nid: 1\n", "\n### Description\n\nA noble.\n\n### Mentality\n\nCalm.\n");
	assert.equal(sameUpToLayout(a, a.replace("Calm.", "Calm!")), false);
	assert.equal(sameUpToLayout(a, a.replace("### Mentality", "### Mentality ")), true, "a trailing space on a heading is layout");
	assert.equal(sameUpToLayout(a, a.replace("### Mentality", "### Mind")), false);
	assert.equal(sameUpToLayout(a, a.replace("A noble.\n\n### Mentality\n\nCalm.", "Calm.\n\n### Mentality\n\nA noble.")), false);
	assert.equal(sameUpToLayout(a, a + "\nExtra line.\n"), false);
});

test("a note with no front matter block at byte 0 is never layout of another", () => {
	assert.equal(sameUpToLayout("\n---\nname: x\n---\n\nA.\n", "---\nname: x\n---\n\nA.\n"), false);
	assert.equal(sameUpToLayout("---\nname: x\n\nA.\n", "---\nname: x\n\n\nA.\n"), false, "an unclosed block is not read");
	assert.equal(sameUpToLayout("plain\n\ntext", "plain\ntext"), false);
	assert.equal(sameUpToLayout("plain\ntext", "plain\ntext"), true);
});
