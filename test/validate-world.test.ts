/**
 * Validate World walks the category folders as the vault really names them.
 *
 * Download and the counts rename every category folder to "Location (2)"; the
 * validator looked for "Location" exactly, skipped every folder and reported
 * "Total elements scanned: 0" on a world of real notes (Seethe's walk of the
 * journey's Obsidian chapter, h57 #4846, on 3.3.1).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";
import { ValidateWorldCommand } from "../Commands/ValidateWorldCommand";

const WORLD = "OnlyWorlds/Worlds/W";
const NOTE = (id: string, name: string) => `---\nid: ${id}\nname: ${name}\nsupertype: town\n---\n\n## Description\n\nA place.\n`;

async function validate(folder: string): Promise<ValidateWorldCommand> {
	const { app, vault } = makeApp();
	await vault.createFolder(`${WORLD}/Elements/${folder}`);
	await vault.create(`${WORLD}/World.md`, "# World Overview: W\n");
	await vault.create(`${WORLD}/Elements/${folder}/Gila River.md`, NOTE("019a0000-0000-7000-8000-000000000001", "Gila River"));
	await vault.create(`${WORLD}/Elements/${folder}/Yuma.md`, NOTE("019a0000-0000-7000-8000-000000000002", "Yuma"));
	const cmd = new ValidateWorldCommand(app, {} as never, new WorldService(app), false);
	await cmd.execute("W");
	return cmd;
}

test("★ a counted category folder (\"Location (2)\") is validated, not skipped", async () => {
	const cmd = await validate("Location (2)");
	assert.equal(cmd.elementCount, 2);
});

test("a bare category folder (\"Location\") still validates", async () => {
	const cmd = await validate("Location");
	assert.equal(cmd.elementCount, 2);
});
