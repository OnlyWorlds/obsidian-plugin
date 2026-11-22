/**
 * A pull finds an element's note wherever it sits in the world's folder (the Markdown
 * profile, sentence 1), through the real DownloadWorldCommand note writer and an in-memory vault.
 *
 * Before, a pull looked for an element's note only in its type's folders, so a note a
 * person had moved to another folder was not found and the element got a second note.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const ID = "019a0000-0000-7000-8000-0000000000f1";
const OTHER = "019a0000-0000-7000-8000-0000000000f2";

async function world() {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	return { app, vault, dl: new DownloadWorldCommand(app, {}) };
}

const mdPaths = (vault: { files: Map<string, unknown> }) => [...vault.files.keys()].filter((p) => p.endsWith(".md") && !p.endsWith("World.md"));

test("★ a note moved out of its type folder is updated in place by the next pull, never made twice", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }] }, false);
	await app.vault.createFolder(`${W}/Cast/Heroes`);
	vault.move(`${ELEMENTS}/Character/Ireena.md`, `${W}/Cast/Heroes/Ireena.md`);
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Changed on the server." }] }, false);
	assert.deepEqual(mdPaths(vault), [`${W}/Cast/Heroes/Ireena.md`], "a second note was made: " + JSON.stringify(mdPaths(vault)));
	assert.match(vault.contentAt(`${W}/Cast/Heroes/Ireena.md`) ?? "", /Changed on the server\./);
});

test("a server rename of a moved note renames it in its own folder, not back into the type folder", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }] }, false);
	await app.vault.createFolder(`${W}/Cast`);
	vault.move(`${ELEMENTS}/Character/Ireena.md`, `${W}/Cast/Ireena.md`);
	(app as unknown as { realRenames: boolean }).realRenames = true;
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Irina", description: "A noble." }] }, false);
	assert.deepEqual(mdPaths(vault), [`${W}/Cast/Irina.md`], JSON.stringify(mdPaths(vault)));
});

test("a person's own note that only mentions an element's id is never written over", async () => {
	const { app, vault, dl } = await world();
	await app.vault.createFolder(`${W}/Diary`);
	const own = `My notes\n\nId of the villain: ${ID}\n`;
	await app.vault.create(`${W}/Diary/Day one.md`, own);
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }] }, false);
	assert.equal(vault.contentAt(`${W}/Diary/Day one.md`), own, "the person's note was rewritten");
	assert.ok(vault.contentAt(`${ELEMENTS}/Character/Ireena.md`), "the element got no note of its own");
});

test("a note of the person's own with an id in its front matter that is not an element's is left alone", async () => {
	const { app, vault, dl } = await world();
	await app.vault.createFolder(`${W}/Diary`);
	const own = `---\nid: day-one\n---\nMy notes\n`;
	await app.vault.create(`${W}/Diary/Day one.md`, own);
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: OTHER, name: "Ireena", description: "A noble." }] }, false);
	assert.equal(vault.contentAt(`${W}/Diary/Day one.md`), own);
});
