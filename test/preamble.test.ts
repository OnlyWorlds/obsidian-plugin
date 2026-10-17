/**
 * Round C, item 2: text before the first heading of a sectioned note is the
 * description (or salvage beside it), and was trimmed. It is kept byte for
 * byte now, less the one blank line that sets the heading apart; a preamble
 * of whitespace alone is layout, not a value.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { bodyToFieldValues, parseElementBody } from "../vault/element-transform";

test("★ text before the first heading reads back byte for byte (its edge whitespace kept)", () => {
	const body = "  Indented stray text.\n\nSecond para.  \n\n### Background\n\nMore.\n";
	assert.equal(parseElementBody(body, "character").preamble, "  Indented stray text.\n\nSecond para.  ");
	assert.equal(bodyToFieldValues(body, "character").description, "  Indented stray text.\n\nSecond para.  ");
});

test("a CRLF preamble loses only the CRLF blank line before its heading", () => {
	const body = "Typed on Windows.\r\n\r\n### Background\r\n\r\nMore.\r\n";
	assert.equal(bodyToFieldValues(body, "character").description, "Typed on Windows.");
});

test("a preamble with no blank line before the heading loses only its line ending", () => {
	assert.equal(parseElementBody("Tight.\t\n### Background\n\nMore.\n", "character").preamble, "Tight.\t");
});

test("a preamble of whitespace alone is layout: no description is made of it", () => {
	const out = bodyToFieldValues("\n\n\n### Description\n\nA knight.\n", "character");
	assert.equal(out.description, "A knight.");
});
