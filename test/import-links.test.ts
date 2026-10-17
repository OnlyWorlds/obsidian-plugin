/**
 * Folder import writes link fields as `[[Name]]`, the way Download does
 * (OW Infra #166 row 17, hop 9 #15: 4,349 of 10,121 Sikelia links came in as
 * raw uuids). The id -> note-name map is built from the folder before any note
 * is written, so a link to an element written later in the run, or one the
 * metadata cache has not indexed yet, still gets its name; a twin's link names
 * its own note (`[[Twin (1)]]`); a target absent from the folder stays a uuid.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, type MockVault } from "./support/obsidian-mock";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";

const WID = "0199d000-0000-7000-8000-0000000000ee";
const IREENA = "0199d000-0000-7000-8000-0000000000c1";
const VALLAKI = "0199d000-0000-7000-8000-0000000000a1";
const TWIN_A = "0199d000-0000-7000-8000-0000000000a2";
const TWIN_B = "0199d000-0000-7000-8000-0000000000a3";
const BRAVE = "0199d000-0000-7000-8000-0000000000b1";
const ELSEWHERE = "0199d000-0000-7000-8000-0000000000ff";

async function importFolder(app: App, vault: MockVault, files: Record<string, unknown>) {
	await vault.seed("in/b/world.json", JSON.stringify({ id: WID, name: "Barovia" }));
	// The character first: every target is written after it.
	for (const [rel, body] of Object.entries(files)) await vault.seed(`in/b/${rel}`, JSON.stringify(body));
	await (new ImportFolderCommand(app) as unknown as { importFolder(d: string): Promise<void> }).importFolder("in/b");
}

const FILES = {
	"elements/character/ireena.json": {
		id: IREENA, type: "character", name: "Ireena",
		birthplace: VALLAKI, location: TWIN_B, traits: [BRAVE, ELSEWHERE],
	},
	"elements/location/vallaki.json": { id: VALLAKI, type: "location", name: "Vallaki" },
	"elements/location/twin-a.json": { id: TWIN_A, type: "location", name: "Twin" },
	"elements/location/twin-b.json": { id: TWIN_B, type: "location", name: "Twin" },
	"elements/trait/brave.json": { id: BRAVE, type: "trait", name: "Brave" },
};

for (const cold of [false, true]) {
	test(`row 17: imported link fields read [[Name]], twins by their own note, an outside target a uuid${cold ? " (cold cache)" : ""}`, async () => {
		const { app, vault, cache } = makeApp();
		cache.coldCache = cold;
		await importFolder(app, vault, FILES);
		const note = vault.contentAt("OnlyWorlds/Worlds/Barovia/Elements/Character/Ireena.md") ?? "";
		assert.match(note, /^birthplace: "\[\[Vallaki\]\]"$/m);
		assert.match(note, /^location: "\[\[Twin \(1\)\]\]"$/m, "the second twin's link must name its own note");
		assert.match(note, /^ {2}- "\[\[Brave\]\]"$/m);
		assert.match(note, new RegExp(`^  - ${ELSEWHERE}$`, "m"), "a target outside the folder stays a uuid");
		// The twins' notes are where the links say.
		assert.match(vault.contentAt("OnlyWorlds/Worlds/Barovia/Elements/Location/Twin.md") ?? "", new RegExp(`^id: ${TWIN_A}$`, "m"));
		assert.match(vault.contentAt("OnlyWorlds/Worlds/Barovia/Elements/Location/Twin (1).md") ?? "", new RegExp(`^id: ${TWIN_B}$`, "m"));
	});
}

test("row 17: a link to an element the vault already has (skipped by the import) names that note", async () => {
	const { app, vault } = makeApp();
	await vault.seed(
		"OnlyWorlds/Worlds/Barovia/Elements/Location/Old Vallaki.md",
		`---\nname: Vallaki\nid: ${VALLAKI}\n---\n\n### Description\n\n`
	);
	await importFolder(app, vault, {
		"elements/character/ireena.json": FILES["elements/character/ireena.json"],
		"elements/location/vallaki.json": FILES["elements/location/vallaki.json"],
	});
	const note = vault.contentAt("OnlyWorlds/Worlds/Barovia/Elements/Character/Ireena.md") ?? "";
	assert.match(note, /^birthplace: "\[\[Old Vallaki\]\]"$/m);
});

test("★ re-importing the same folder before Obsidian has indexed the notes writes no duplicate (Kael's read, 3)", async () => {
	const { app, vault, cache } = makeApp();
	await importFolder(app, vault, FILES);
	const before = [...vault.files.keys()].filter((p) => p.startsWith("OnlyWorlds/Worlds/Barovia/Elements/")).sort();
	const ireena = vault.contentAt("OnlyWorlds/Worlds/Barovia/Elements/Character/Ireena.md");
	cache.coldCache = true; // the notes exist on disk; the metadata cache knows none of them yet
	await (new ImportFolderCommand(app) as unknown as { importFolder(d: string): Promise<void> }).importFolder("in/b");
	const after = [...vault.files.keys()].filter((p) => p.startsWith("OnlyWorlds/Worlds/Barovia/Elements/")).sort();
	assert.deepEqual(after, before, "a second note appeared for an id the vault already had");
	assert.equal(vault.contentAt("OnlyWorlds/Worlds/Barovia/Elements/Character/Ireena.md"), ireena, "an existing note was rewritten");
});
