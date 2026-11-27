/**
 * Paste world writes over an element's note as Download does, so it keeps a copy as Download does: a note it is about to
 * replace and cannot prove unchanged since the plugin last wrote or saved it (its bytes do not hash to the id's mark, or there
 * is no mark, or the index cannot be read) is copied whole into Kept edits/ first, the copies are named in one notice, and the
 * mark of every note it writes is the hash of the bytes the write put there, so a later pull is not noisy.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, __notices } from "./support/obsidian-mock";
import type { MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { PasteWorldCommand } from "../Commands/PasteWorldCommand";
import { asKeptCopy, markKey, noteMark } from "../vault/note-mark-core";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const NOTE = `${ELEMENTS}/Character/Ireena.md`;
const OTHER_NOTE = `${ELEMENTS}/Character/Kolyan.md`;
const SEQ = `${W}/.ow-seq.json`;
const KEPT = `${W}/Kept edits/`;
const ID = "019a0000-0000-7000-8000-0000000001f1";
const OTHER = "019a0000-0000-7000-8000-0000000001f2";

type Vaultish = { create(p: string, c: string): Promise<unknown> };

async function world() {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	return { app, vault, dl: new DownloadWorldCommand(app, {}), paste: new PasteWorldCommand(app, {} as never) };
}
const el = (description: string) => ({ Character: [{ id: ID, name: "Ireena", description }] });
const index = (vault: MockVault): Record<string, number> => JSON.parse(vault.dotfiles.get(SEQ) ?? "{}");
const copies = (vault: MockVault) => [...vault.files.keys()].filter((p) => p.startsWith(KEPT));
function typeInto(vault: MockVault, path: string, text: string): void {
	const e = vault.files.get(path);
	if (!e) throw new Error(`no note at ${path}`);
	e.content = e.content.replace("### Description\n\n", `### Description\n\n${text} `);
}

test("★ Paste world copies a note typed into before it writes over it, names it in one notice, and marks the bytes it wrote", async () => {
	const { vault, dl, paste } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	typeInto(vault, NOTE, "Typed by a person.");
	const typed = vault.contentAt(NOTE) ?? "";
	__notices.length = 0;
	await paste.generateElementNotes(ELEMENTS, el("Pasted over."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Pasted over\./, "the pasted copy was not written");
	const made = copies(vault);
	assert.equal(made.length, 1, `Paste world wrote over a typed note with no copy: ${JSON.stringify(made)}`);
	assert.equal(vault.contentAt(made[0]), asKeptCopy(typed), "the copy is not the note as it was");
	const said = __notices.filter((n) => n.includes("could not tell were unedited"));
	assert.equal(said.length, 1, __notices.join(" | "));
	assert.match(said[0], /^Paste world /, said[0]);
	assert.match(said[0], /Character "Ireena"/, said[0]);
	assert.equal(index(vault)[markKey(ID)], noteMark(vault.contentAt(NOTE) ?? ""), "Paste world recorded no mark for the note it wrote");
});

test("Paste world writes over a note that matches its mark with no copy", async () => {
	const { vault, dl, paste } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	await paste.generateElementNotes(ELEMENTS, el("Pasted over."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Pasted over\./);
	assert.deepEqual(copies(vault), []);
});

test("Paste world copies a note with no mark, and one under an index that cannot be read", async () => {
	for (const index of ["{}\n", '{"half": 1, ']) {
		const { vault, dl, paste } = await world();
		await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
		vault.dotfiles.set(SEQ, index);
		await paste.generateElementNotes(ELEMENTS, el("Pasted over."), false);
		assert.equal(copies(vault).length, 1, `no copy under the index ${JSON.stringify(index)}`);
		assert.match(vault.contentAt(NOTE) ?? "", /Pasted over\./);
	}
});

test("★ a pull after a paste is not noisy: the pasted notes carry their marks, so an untouched one is replaced with no copy", async () => {
	const { vault, dl, paste } = await world();
	await paste.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Pasted." }, { id: OTHER, name: "Kolyan", description: "Pasted too." }] }, false);
	assert.ok(vault.contentAt(NOTE) && vault.contentAt(OTHER_NOTE));
	const r = await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "From the world." }, { id: OTHER, name: "Kolyan", description: "From the world too." }] }, false);
	assert.deepEqual(r.copied, [], "the pull copied notes Paste world had just written");
	assert.deepEqual(copies(vault), []);
});

test("★ a copy Paste world cannot write stops it before that note: the note is not changed, the notice says so, and the notes it wrote keep their marks", async () => {
	const { app, vault, dl, paste } = await world();
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "A noble." }, { id: OTHER, name: "Kolyan", description: "A priest." }] }, false);
	typeInto(vault, OTHER_NOTE, "Typed by a person.");
	const typed = vault.contentAt(OTHER_NOTE);
	const v = app.vault as unknown as Vaultish;
	const create = v.create.bind(v);
	v.create = async (p, c) => {
		if (p.startsWith(KEPT)) throw new Error("the disk is full");
		return create(p, c);
	};
	__notices.length = 0;
	const r = await paste.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Pasted." }, { id: OTHER, name: "Kolyan", description: "Pasted too." }] }, false);
	assert.equal(vault.contentAt(OTHER_NOTE), typed, "the note whose copy failed was changed");
	assert.match(vault.contentAt(NOTE) ?? "", /Pasted\./);
	assert.equal(index(vault)[markKey(ID)], noteMark(vault.contentAt(NOTE) ?? ""), "the mark of the note Paste world wrote was not recorded");
	assert.match(r.stopped ?? "", /^Paste world stopped at Character "Kolyan"/, r.stopped ?? "no stop");
	assert.match(r.stopped ?? "", /not changed/);
});
