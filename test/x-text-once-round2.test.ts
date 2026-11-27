/**
 * #2362, the cold reads' findings (an Opus reader and Codex; two of the three the second found, the first found too):
 * a person's `x_color` beside a tool's `atlas_color` is read by the property copy, so it stays a property; a held heading the reader
 * would not take as a field is not re-used; a twin check that looks at every kind of property value, line endings aside, and at an
 * element id as the link it is; and Migrate writes an `x_` text key as its section.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { readElement, writeElement } from "../vault/element-file";
import { writesAsSection } from "../vault/element-transform";
import { MigrateWorldCommand } from "../Commands/MigrateWorldCommand";

const ID = "0199c000-0000-7000-8000-0000000000c2";
const BOB = "0199c000-0000-7000-8000-0000000000b0";
const PATH = "OnlyWorlds/Worlds/W/Elements/Character/Ireena.md";
const head = (fm: string, eol = "\n") => `---${eol}name: Ireena${eol}id: ${ID}${eol}${fm}---${eol}${eol}### Description${eol}${eol}A noble.${eol}`;

async function written(existing: string | null, data: Record<string, unknown>) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	if (existing !== null) await vault.seed(PATH, existing);
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", ...data });
	return { app, vault, file, text: await vault.read(file as never) };
}

test("★ a person's x_color beside a tool's atlas_color stays a property, and reads back (red on cd24c0e: the section was taken for the tool's copy)", async () => {
	assert.ok(!writesAsSection("x_color", "Red", "character", ["x_color", "atlas_color"]), "the tool's key gives the same heading");
	assert.ok(!writesAsSection("x_flag", "x", "character", ["shadow_flag"]));
	assert.ok(writesAsSection("x_color", "Red", "character", ["x_color"]), "with no tool key beside it, the section's alone");
	const w = await written(null, { x_color: "Red", atlas_color: "#f00" });
	assert.ok(w.text.includes("x_color: Red\n") && !w.text.includes("### Color"), w.text);
	const read = await readElement(w.app, w.file as never);
	assert.equal(read?.fields.x_color, "Red");
	// the person edits the property; the next read sends the edit
	const edited = w.text.replace("x_color: Red", "x_color: Blue");
	await w.vault.modify(w.file as never, edited);
	assert.equal((await readElement(w.app, w.file as never))?.fields.x_color, "Blue");
});

test("★ a held heading the reader would not take as a field is not used: the text stays its x_ field (red on cd24c0e: it went into the description)", async () => {
	for (const odd of ["My\tnotes", "My notes"]) {
		const w = await written(head("") + `\n### ${odd}\n\nold\n`, { x_my_notes: "server text" });
		const read = await readElement(w.app, w.file as never);
		assert.equal(read?.fields.x_my_notes, "server text", JSON.stringify(odd) + "\n" + w.text);
		assert.equal(read?.fields.description, "A noble.", JSON.stringify(odd));
	}
});

const twin = async (property: string, eol = "\n", section = "Tall.") => {
	const { app, vault } = makeApp();
	const f = await vault.seed(PATH, head(property, eol) + `${eol}### Looks${eol}${eol}${section}${eol}`);
	return readElement(app, f as never);
};

test("★ a property emptied, or made a number, a date, a boolean or a list, beside a section: refused by name (red on cd24c0e: the section was sent, the edit lost)", async () => {
	for (const prop of ["x_looks:\n", "x_looks: 43\n", "x_looks: true\n", "x_looks: 2024-01-02\n", "x_looks:\n  - a\n  - b\n", "x_looks: {a: 1}\n"]) {
		assert.deepEqual((await twin(prop))?.twinTexts, ["x_looks"], prop);
	}
	assert.equal((await twin("x_looks: Tall.\n"))?.twinTexts, undefined, "the equal copies are one");
	assert.equal((await twin("x_looks:\n", "\n", ""))?.twinTexts, undefined, "an empty property beside an empty section is one empty text");
});

test("★ a note whose copies agree in the CRLF a Windows editor leaves is not refused (red on cd24c0e)", async () => {
	const read = await twin('x_looks: "first\\nsecond"\r\n', "\r\n", "first\r\nsecond");
	assert.equal(read?.twinTexts, undefined, JSON.stringify(read?.fields.x_looks));
});

test("★ an old note holding an element id as a link property and as the id's text is one text, not a twin (red on cd24c0e: refused unedited)", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Bob.md", `---\nname: Bob\nid: ${BOB}\n---\n\n### Description\n\nA man.\n`);
	const f = await vault.seed(PATH, head('x_ruler: "[[Bob]]"\n') + `\n### Ruler\n\n${BOB}\n`);
	const read = await readElement(app, f as never);
	assert.equal(read?.twinTexts, undefined);
	assert.equal(read?.fields.x_ruler, BOB);
});

test("★ Migrate writes a span's x_ text key as its section (red on cd24c0e: the text was gone from the note)", async () => {
	const { app, vault } = makeApp();
	const file = await vault.seed(PATH, "old span note");
	const cmd = new MigrateWorldCommand(app as never, () => {}) as unknown as {
		writeFrontmatterNote(f: unknown, content: string, category: string, id: string, fm: Record<string, unknown>, body: string, idToName: (i: string) => string | null): Promise<void>;
	};
	await cmd.writeFrontmatterNote(file, "old span note", "character", ID, { name: "Ireena", x_looks: "Tall." }, "A noble.", () => null);
	const text = await vault.read(file as never);
	assert.ok(text.includes("### Looks\n\nTall.\n") || text.includes("x_looks: Tall."), text);
	assert.ok(!(text.includes("### Looks") && text.includes("x_looks:")), "once, not twice:\n" + text);
});
