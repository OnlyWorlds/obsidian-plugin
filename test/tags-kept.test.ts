/**
 * What the plugin does with the `tags` of a note (Obsidian's own property): a save sends none of
 * it, and a pull leaves the note's tags as they are. The world never holds a tag, so a vault that
 * never held the note has none after a pull.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { readElement, writeElement } from "../vault/element-file";

const ID = "0199c000-0000-7000-8000-0000000000b1";
const PATH = "OnlyWorlds/Worlds/W/Elements/Character/Ireena.md";

test("a save sends no tags, and a pull over the note keeps them", async () => {
	const { app, vault } = makeApp();
	const f = await vault.seed(PATH, `---\nname: Ireena\nid: ${ID}\ntags:\n  - ow/character\n  - villain\nmood: tense\n---\n\n### Description\n\nA noble.\n`);
	const read = await readElement(app, f as unknown as TFile);
	assert.deepEqual(read?.fields.x_properties, { mood: "tense" }, "tags is no entry of the group");
	assert.equal("tags" in (read?.fields ?? {}), false);
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", x_properties: { mood: "calm" } });
	const after = vault.contentAt(PATH) ?? "";
	assert.match(after, /tags:\n  - ow\/character\n  - villain/, after);
	assert.match(after, /mood: calm/);
});

test("a pull into a vault that never held the note writes no tags", async () => {
	const { app, vault } = makeApp();
	await vault.createFolder("OnlyWorlds/Worlds/W/Elements/Character");
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", x_properties: { mood: "calm" } });
	assert.doesNotMatch(vault.contentAt(PATH) ?? "", /tags/);
});
