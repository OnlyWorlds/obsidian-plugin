/**
 * Only the format's own field heading (`###`) starts a field — run on the pure
 * transform and through the REAL writeElement / readElement (in-memory vault).
 *
 * ★ Row 1 of the data-paths ranking (OW Infra #166, hop 9 #4): reading took
 * `##` as a field boundary too, so a `## Notes` line inside a description split
 * it into an `x_notes` field. Ruling (Skeld): `#`, `##`, `####` and deeper inside
 * a field's text are prose and stay in that field. A `###` that names no known
 * field still becomes a custom field (`### Looks` -> `x_looks`, the README).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { buildElementBody, bodyToFieldValues, parseElementBody } from "../vault/element-transform";
import { writeElement, readElement } from "../vault/element-file";

const ID = "019a0000-0000-7000-8000-0000000000a9";
const DESCRIPTION = [
	"A knight of Barovia.",
	"",
	"## Notes",
	"",
	"Met the party at the gate.",
	"",
	"#### Aside",
	"",
	"She lies about her age.",
	"",
	"# Epilogue",
	"",
	"Gone by spring.",
].join("\n");

test("★ `## Notes` and `#### Aside` inside a description stay in it, byte for byte (row 1)", () => {
	const body = buildElementBody({ description: DESCRIPTION, physicality: "Tall." }, "character");
	assert.deepEqual(parseElementBody(body, "character").unknown, [], "no section split off the description");
	const back = bodyToFieldValues(body, "character");
	assert.equal(back.description, DESCRIPTION);
	assert.equal(back.physicality, "Tall.");
});

test("★ a `## Background` line inside a description is prose, not the Background field (row 1)", () => {
	const description = "Her public face.\n\n## Background\n\nHer secret past.";
	const body = buildElementBody({ description, background: "Born in Vallaki." }, "character");
	const back = bodyToFieldValues(body, "character");
	assert.equal(back.description, description);
	assert.equal(back.background, "Born in Vallaki.");
});

test("★ the same description survives writeElement -> readElement with no x_ field split off (row 1)", async () => {
	const { app } = makeApp();
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", description: DESCRIPTION });
	const back = await readElement(app, file);
	assert.ok(back);
	assert.equal(back.fields.description, DESCRIPTION);
	assert.deepEqual(Object.keys(back.fields).filter((k) => k.startsWith("x_")), []);
});

test("a `###` heading naming no field still becomes a custom field (README: `### Looks` -> x_looks)", async () => {
	const { app, vault } = makeApp();
	const path = "OnlyWorlds/Worlds/W/Elements/Character/Ireena.md";
	const file = await vault.seed(
		path,
		`---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nA knight.\n\n### Looks\n\nAuburn hair.\n`
	);
	const back = await readElement(app, file as never);
	assert.equal(back?.fields.description, "A knight.");
	assert.equal(back?.fields.x_looks, "Auburn hair.");
});
