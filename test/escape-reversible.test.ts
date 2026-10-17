/**
 * Round C fix round, item 3 (Kael's c-read, low 3): a `\###` line meant
 * `###` in a section but kept its backslash in the text before the first
 * heading and in a heading-less body, so the same line read two ways.
 *
 * The escape is one rule, reversible both ways, wherever a value is read
 * from a note: a line that starts with a backslash run and then `### ` (or
 * a fence run) gains one more backslash on write and loses one on read. So
 * every value round-trips byte for byte, a server value that already holds
 * `\### ` included.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { bodyToFieldValues } from "../vault/element-transform";
import { readElement, writeElement } from "../vault/element-file";

const ID = "0199c000-0000-7000-8000-0000000000f3";

test("★ a `\\###` line before the first heading reads as `###`, as it does in a section", () => {
	const out = bodyToFieldValues("Intro.\n\\### Not a heading\n\n### Description\n\n\\### In a section\n", "character");
	assert.equal(out.description, "### In a section\n\nIntro.\n### Not a heading");
});

test("★ a `\\###` line in a heading-less body reads as `###`", () => {
	const out = bodyToFieldValues("Line one.\n\\### Not a heading\n\\\\### kept one\n", "character");
	assert.equal(out.description, "Line one.\n### Not a heading\n\\### kept one");
});

test("★ server values led by backslash runs round-trip byte for byte through a note", async () => {
	const { app } = makeApp();
	const values = {
		description: "\\### typed in 3.5.0\n\\\\### twice\n### plain",
		background: "\\~~~ a typed escape\n\\```",
	};
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", ...values });
	const parsed = await readElement(app, file as TFile);
	assert.ok(parsed);
	assert.equal(parsed.fields.description, values.description);
	assert.equal(parsed.fields.background, values.background);
});
