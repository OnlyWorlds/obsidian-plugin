/**
 * A note anywhere in a world's folder, in a folder export (the Markdown profile, sentences 1 to 3).
 *
 * Export as OnlyWorlds folder used to read every note under a world's `Elements/` and take its type from the
 * name of the folder it sat in, so a note in `Elements/Places/` was written as `elements/places/...json`
 * with the type `places`: a folder no reader of the folder format accepts. Then a note outside the type folders was skipped.
 * Now the place decides the type (the first folder below the world's folder named for one of the 22), and only a note
 * outside every type folder is read by its `type` property, with an id that is a UUID. Any other note is the person's own.
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
const OTHER_ID = "0199c000-0000-7000-8000-0000000000c3";
const W = "OnlyWorlds/Worlds/W";
const EL = `${W}/Elements`;

async function exportWorld(app: App, vault: MockVault): Promise<string[]> {
	const before = new Set(vault.files.keys());
	const cmd = new ExportFolderCommand(app) as unknown as { exportWorld(world: string, dest: { kind: "vault" }): Promise<void> };
	await cmd.exportWorld("W", { kind: "vault" });
	return [...vault.files.keys()].filter((p) => !before.has(p) && p.startsWith("OW-folder-export/")).map((p) => p.split("/").slice(2).join("/"));
}

function skippedOf(): { path: string; reason: string }[] {
	return (__modals.at(-1) as unknown as { failed?: { path: string; reason: string }[] })?.failed ?? [];
}

/** An exported element's JSON, by its path inside the export folder. */
function exportedJson(vault: MockVault, rel: string): Record<string, unknown> {
	const key = [...vault.files.keys()].find((k) => k.startsWith("OW-folder-export/") && k.endsWith("/" + rel))!;
	return JSON.parse(vault.files.get(key)!.content);
}

async function seed(app: App, path: string, text: string): Promise<void> {
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
	await app.vault.create(path, text);
}

test("★ a note in a folder that is none of the 22 types is read by its type property, and no made-up type folder is written", async () => {
	const { app, vault } = makeApp();
	await writeElement(app, "W", "character", CHAR_ID, { name: "Ireena", description: "A noble." });
	await seed(app, `${EL}/Places/Akragas.md`, `---\nid: ${PLACE_ID}\nname: Akragas\ntype: location\n---\n\n### Description\nA hill town.\n`);
	const out = await exportWorld(app, vault);
	assert.ok(out.some((p) => p.startsWith("elements/character/")), "the character did not export: " + JSON.stringify(out));
	assert.ok(out.some((p) => p.startsWith("elements/location/akragas")), "the typed note did not export as a Location: " + JSON.stringify(out));
	assert.ok(!out.some((p) => p.startsWith("elements/places/")), "a folder named for the note's folder was written: " + JSON.stringify(out));
	assert.deepEqual(skippedOf().map((f) => f.path), [], JSON.stringify(skippedOf()));
});

test("a note outside the Elements folder, anywhere in the world's folder, is an element note by its id and type", async () => {
	const { app, vault } = makeApp();
	await seed(app, `${W}/Notes/Deep/Akragas.md`, `---\nid: ${PLACE_ID}\nname: Akragas\ntype: Location\n---\n\n### Description\nA hill town.\n`);
	const out = await exportWorld(app, vault);
	assert.ok(out.some((p) => p.startsWith("elements/location/akragas")), JSON.stringify(out));
});

test("an element id with no type to read it by is named and skipped; a note with no id is the person's own and is left", async () => {
	const { app, vault } = makeApp();
	await writeElement(app, "W", "character", CHAR_ID, { name: "Ireena", description: "A noble." });
	await seed(app, `${EL}/Places/Typeless.md`, `---\nid: ${PLACE_ID}\nname: Typeless\n---\n\n### Description\nNo type.\n`);
	await seed(app, `${W}/Notes/Diary.md`, `---\nname: Diary\ntype: npc\n---\n\nMy own note.\n`);
	const out = await exportWorld(app, vault);
	assert.ok(out.some((p) => p.startsWith("elements/character/")), JSON.stringify(out));
	assert.deepEqual(skippedOf().map((f) => f.path), [`${EL}/Places/Typeless.md`], JSON.stringify(skippedOf()));
	assert.match(skippedOf()[0].reason, /not in a type folder, and its type property names none of the 22 types/);
	assert.ok(!out.some((p) => /diary/.test(p)), "a note of the person's own was exported: " + JSON.stringify(out));
});

test("the folder decides: a type property in a type folder is the person's own property, and the note stays of its folder's type", async () => {
	const { app, vault } = makeApp();
	await seed(app, `${EL}/Character/Misfiled.md`, `---\nid: ${CHAR_ID}\nname: Misfiled\ntype: location\n---\n\n### Description\nIn Character/.\n`);
	const out = await exportWorld(app, vault);
	assert.ok(out.some((p) => p.startsWith("elements/character/misfiled")), JSON.stringify(out));
	assert.ok(!out.some((p) => p.startsWith("elements/location/")), JSON.stringify(out));
	const json = exportedJson(vault, out.find((p) => p.startsWith("elements/character/misfiled"))!);
	assert.deepEqual(json.x_properties, { type: "location" });
});

test("a type property that only repeats the note's folder does not cross", async () => {
	const { app, vault } = makeApp();
	await seed(app, `${EL}/Location/Akragas.md`, `---\nid: ${PLACE_ID}\nname: Akragas\ntype: location\n---\n\n### Description\nA hill town.\n`);
	const out = await exportWorld(app, vault);
	const json = exportedJson(vault, out.find((p) => p.startsWith("elements/location/akragas"))!);
	assert.equal("x_properties" in json, false, JSON.stringify(json));
});

test("a note in a dot-folder or in records/ is never read as an element", async () => {
	const { app, vault } = makeApp();
	await seed(app, `${W}/.trash/Gone.md`, `---\nid: ${OTHER_ID}\nname: Gone\ntype: location\n---\n`);
	await seed(app, `${W}/records/lab/Record.md`, `---\nid: ${PLACE_ID}\nname: Record\ntype: location\n---\n`);
	await seed(app, `${W}/Places/Akragas.md`, `---\nid: ${CHAR_ID}\nname: Akragas\ntype: location\n---\n`);
	const out = await exportWorld(app, vault);
	assert.deepEqual(out.filter((p) => p.startsWith("elements/")).map((p) => p.split("--")[0]), ["elements/location/akragas"], JSON.stringify(out));
});

test("a note in a type folder still exports as before (the type folder is the type)", async () => {
	const { app, vault } = makeApp();
	await writeElement(app, "W", "location", PLACE_ID, { name: "Akragas", description: "A hill town." });
	const out = await exportWorld(app, vault);
	assert.ok(out.some((p) => p.startsWith("elements/location/akragas")), JSON.stringify(out));
});
