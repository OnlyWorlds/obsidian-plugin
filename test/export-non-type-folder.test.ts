/**
 * A note whose folder is not one of the 22 types, in a folder export.
 *
 * Export as OnlyWorlds folder read every note under a world's `Elements/` and took its type from the
 * name of the folder it sat in, so a note in `Elements/Places/` was written as `elements/places/...json`
 * with the type `places`: a folder no reader of the folder format accepts. A note outside the type folders has no
 * type to export under; it is skipped by name and reason, and the world's other notes export as before.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, __modals, type MockVault } from "./support/obsidian-mock";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { writeElement } from "../vault/element-file";

const CHAR_ID = "0199c000-0000-7000-8000-0000000000c1";
const PLACE_ID = "0199c000-0000-7000-8000-0000000000c2";
const EL = "OnlyWorlds/Worlds/W/Elements";

async function exportWorld(app: App, vault: MockVault): Promise<string[]> {
	const before = new Set(vault.files.keys());
	const cmd = new ExportFolderCommand(app) as unknown as { exportWorld(world: string, dest: { kind: "vault" }): Promise<void> };
	await cmd.exportWorld("W", { kind: "vault" });
	return [...vault.files.keys()].filter((p) => !before.has(p) && p.startsWith("OW-folder-export/")).map((p) => p.split("/").slice(2).join("/"));
}

test("★ a note in a folder that is none of the 22 types is skipped by name, and no made-up type folder is written", async () => {
	const { app, vault } = makeApp();
	await writeElement(app, "W", "character", CHAR_ID, { name: "Ireena", description: "A noble." });
	await app.vault.createFolder(`${EL}/Places`);
	await app.vault.create(`${EL}/Places/Akragas.md`, `---\nid: ${PLACE_ID}\nname: Akragas\ntype: location\n---\n\n### Description\nA hill town.\n`);
	const out = await exportWorld(app, vault);
	assert.ok(out.some((p) => p.startsWith("elements/character/")), "the character did not export: " + JSON.stringify(out));
	assert.ok(!out.some((p) => p.startsWith("elements/places/")), "a folder named for the note's folder was written: " + JSON.stringify(out));
	// the report dialog is handed the skipped notes; it lists each with its reason
	const skipped = (__modals.at(-1) as unknown as { failed?: { path: string; reason: string }[] })?.failed ?? [];
	assert.deepEqual(skipped.map((f) => f.path), [`${EL}/Places/Akragas.md`], "the skipped note is not named: " + JSON.stringify(skipped));
	assert.match(skipped[0].reason, /not in a type folder \(the folder "Places" is none of the 22 types\)/);
});

test("a note in a type folder still exports as before (the type folder is the type)", async () => {
	const { app, vault } = makeApp();
	await writeElement(app, "W", "location", PLACE_ID, { name: "Akragas", description: "A hill town." });
	const out = await exportWorld(app, vault);
	assert.ok(out.some((p) => p.startsWith("elements/location/akragas")), JSON.stringify(out));
});
