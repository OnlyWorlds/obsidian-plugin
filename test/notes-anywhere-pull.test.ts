/**
 * A pull finds an element's note wherever it sits in the world's folder (the Markdown
 * profile, sentence 1), through the real DownloadWorldCommand note writer and an in-memory vault.
 *
 * A note is an element's only by the rule Save uses: an id and a type, by place or by the `type`
 * property (a UUID id outside the plugin's own Elements/ folder). A person's own note, or a copy
 * with no type, is never written to, renamed or linked to by a pull.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { KeptCopies } from "../vault/kept-copy";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const ID = "019a0000-0000-7000-8000-0000000000f1";
const OTHER = "019a0000-0000-7000-8000-0000000000f2";
const KOLYAN = "019a0000-0000-7000-8000-0000000000f3";

async function world() {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	return { app, vault, dl: new DownloadWorldCommand(app, {}) };
}

const mdPaths = (vault: { files: Map<string, unknown> }) => [...vault.files.keys()].filter((p) => p.endsWith(".md") && !p.endsWith("World.md") && !p.includes("/Kept edits/")).sort(); // the pull's copy of a typed note is no element note

/** Move the element's note out of its type folder; `typed` gives it a `type` property, as a person would. */
async function moveOut(app: ReturnType<typeof makeApp>["app"], vault: ReturnType<typeof makeApp>["vault"], to: string, typed: boolean) {
	await app.vault.createFolder(to.slice(0, to.lastIndexOf("/")));
	vault.move(`${ELEMENTS}/Character/Ireena.md`, to);
	if (typed) {
		const file = app.vault.getAbstractFileByPath(to)!;
		await app.vault.modify(file as never, (vault.contentAt(to) ?? "").replace(/^id: /m, "type: character\nid: "));
	}
}

test("★ a note moved out of its type folder and given a type is updated in place by the next pull, never made twice", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }] }, false);
	await moveOut(app, vault, `${W}/Cast/Heroes/Ireena.md`, true);
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Changed on the server." }] }, false);
	assert.deepEqual(mdPaths(vault), [`${W}/Cast/Heroes/Ireena.md`], "a second note was made: " + JSON.stringify(mdPaths(vault)));
	assert.match(vault.contentAt(`${W}/Cast/Heroes/Ireena.md`) ?? "", /Changed on the server\./);
});

test("★ a moved note with no type is the person's own: the pull never writes over it, and the element gets its note again", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }] }, false);
	await moveOut(app, vault, `${W}/Drafts/Ireena.md`, false);
	const mine = vault.contentAt(`${W}/Drafts/Ireena.md`);
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A co-author's edit." }] }, false);
	assert.equal(vault.contentAt(`${W}/Drafts/Ireena.md`), mine, "the person's own note was written over");
	assert.match(vault.contentAt(`${ELEMENTS}/Character/Ireena.md`) ?? "", /A co-author's edit\./);
});

test("a server rename of a moved, typed note renames it in its own folder, not back into the type folder", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }] }, false);
	await moveOut(app, vault, `${W}/Cast/Ireena.md`, true);
	(app as unknown as { realRenames: boolean }).realRenames = true;
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Irina", description: "A noble." }] }, false);
	assert.deepEqual(mdPaths(vault), [`${W}/Cast/Irina.md`], JSON.stringify(mdPaths(vault)));
});

test("★ a person's copy of the element's note, with its id and no type, is neither renamed nor written, and no link names it", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }, { id: KOLYAN, name: "Kolyan" }] }, false);
	await app.vault.createFolder(`${W}/Drafts`);
	const copy = `---\nname: Ireena rewrite\nid: ${ID}\n---\n\nMy rewrite.\n`;
	await app.vault.create(`${W}/Drafts/A rewrite.md`, copy);
	(app as unknown as { realRenames: boolean }).realRenames = true;
	// Ireena is renamed on the server, and Kolyan (changed alone) links to her
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Irina", description: "A noble." }] }, false);
	assert.equal(vault.contentAt(`${W}/Drafts/A rewrite.md`), copy, "the copy was written or renamed");
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: KOLYAN, name: "Kolyan", friends: [ID] }] }, false);
	const kolyan = vault.contentAt(`${ELEMENTS}/Character/Kolyan.md`) ?? "";
	assert.doesNotMatch(kolyan, /A rewrite/, kolyan);
	assert.match(kolyan, /\[\[Irina\]\]/, kolyan);
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

test("a note in a type-named folder outside Elements/ with another plugin's id is the person's own: a pull never writes to it", async () => {
	const { app, vault, dl } = await world();
	await app.vault.createFolder(`${W}/Notes/Character`);
	const own = `---\nid: idea-20231122\nname: Idea\n---\nA note.\n`;
	await app.vault.create(`${W}/Notes/Character/Idea.md`, own);
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: "idea-20231122", name: "Idea", description: "From the server." }] }, false);
	assert.equal(vault.contentAt(`${W}/Notes/Character/Idea.md`), own);
});

test("a hidden element's note outside the type folders is stubbed by the pull too", async () => {
	const { app, vault, dl } = await world();
	await app.vault.createFolder(`${W}/Cast`);
	await app.vault.create(`${W}/Cast/Ireena.md`, `---\nname: Ireena\nid: ${ID}\ntype: character\n---\n\n### Description\n\nSecret backstory.\n`);
	const stub = await (dl as unknown as { stubNotes(ids: string[], files: Map<string, unknown>, copies: KeptCopies, out: { marks: Record<string, number>; left: string[]; failed: unknown[] }): Promise<{ n: number }> }).stubNotes(
		[ID],
		new Map([[ID, app.vault.getAbstractFileByPath(`${W}/Cast/Ireena.md`)!]]),
		await KeptCopies.open(app, "W"),
		{ marks: {}, left: [], failed: [] }
	);
	assert.equal(stub.n, 1);
	assert.doesNotMatch(vault.contentAt(`${W}/Cast/Ireena.md`) ?? "", /Secret backstory/);
});
