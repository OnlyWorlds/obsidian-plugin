/**
 * Validate World walks the category folders as the vault really names them, and
 * checks what it counts.
 *
 * Up to 3.8.1 Download and the counts renamed every category folder to
 * "Location (2)" (a vault not downloaded since may still hold one); the
 * validator looked for "Location" exactly, skipped every folder and reported
 * "Total elements scanned: 0" on a world of real notes (Seethe's walk of the
 * journey's Obsidian chapter, h57 #4846, on 3.3.1). Then, with the folders
 * found, it counted frontmatter notes and checked none of them, so a note with
 * no id passed as "No issues" (h57 #4864). Frontmatter notes now get the two
 * checks that hold in that format: an id, and a name that matches the file.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";
import { ValidateWorldCommand } from "../Commands/ValidateWorldCommand";

const WORLD = "OnlyWorlds/Worlds/W";
const ID1 = "019a0000-0000-7000-8000-000000000001";
const ID2 = "019a0000-0000-7000-8000-000000000002";
const NOTE = (id: string | null, name: string) =>
	`---\n${id === null ? "" : `id: ${id}\n`}name: ${name}\nsupertype: town\n---\n\n## Description\n\nA place.\n`;

async function validate(folder: string, notes: Record<string, string>): Promise<ValidateWorldCommand> {
	const { app, vault } = makeApp();
	await vault.createFolder(`${WORLD}/Elements/${folder}`);
	await vault.create(`${WORLD}/World.md`, "# World Overview: W\n");
	for (const [file, content] of Object.entries(notes)) {
		await vault.create(`${WORLD}/Elements/${folder}/${file}`, content);
	}
	const cmd = new ValidateWorldCommand(app, {} as never, new WorldService(app), false);
	await cmd.execute("W");
	return cmd;
}

const GOOD = { "Gila River.md": NOTE(ID1, "Gila River"), "Yuma.md": NOTE(ID2, "Yuma") };

test("★ a counted category folder (\"Location (2)\") is validated, not skipped", async () => {
	const cmd = await validate("Location (2)", GOOD);
	assert.equal(cmd.elementCount, 2);
	assert.equal(cmd.checkedCount, 2);
	assert.equal(cmd.errorCount, 0);
});

test("a bare category folder (\"Location\") still validates", async () => {
	const cmd = await validate("Location", GOOD);
	assert.equal(cmd.elementCount, 2);
	assert.equal(cmd.errorCount, 0);
});

test("★ a frontmatter note without an id is an error, not a pass", async () => {
	const cmd = await validate("Location (2)", { "Gila River.md": NOTE(null, "Gila River"), "Yuma.md": NOTE(ID2, "Yuma") });
	assert.equal(cmd.checkedCount, 2);
	assert.equal(cmd.errorCount, 1);
	assert.match(cmd.errors.missingIdErrors[0], /Gila River.*Id/);
});

test("a frontmatter note whose name does not match its file is an error", async () => {
	const cmd = await validate("Location (2)", { "Gila River.md": NOTE(ID1, "Colorado River"), "Yuma.md": NOTE(ID2, "Yuma") });
	assert.equal(cmd.errorCount, 1);
	assert.match(cmd.errors.nameMismatchErrors[0], /Gila River.*Name/);
});

test("★ a second run on the same command object counts afresh (Seethe saw Checked 2, 4, 6, 8)", async () => {
	const { app, vault } = makeApp();
	await vault.createFolder(`${WORLD}/Elements/Location (2)`);
	await vault.create(`${WORLD}/World.md`, "# World Overview: W\n");
	for (const [file, content] of Object.entries(GOOD)) await vault.create(`${WORLD}/Elements/Location (2)/${file}`, content);
	const cmd = new ValidateWorldCommand(app, {} as never, new WorldService(app), false);
	await cmd.execute("W");
	await cmd.execute("W");
	assert.equal(cmd.elementCount, 2);
	assert.equal(cmd.checkedCount, 2);
});

test("a numbered twin (\"Guard (2).md\") and a filed-safe name are not mismatches", async () => {
	const cmd = await validate("Character (2)", {
		"Guard (2).md": NOTE(ID1, "Guard"),
		"Angel Trias.md": NOTE(ID2, "Angel Trias"),
	});
	assert.equal(cmd.errorCount, 0);
});
