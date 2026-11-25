/**
 * A pull leaves a note that holds unsaved edits (the note mark, vault/note-mark-core.ts), through the real
 * DownloadWorldCommand note writer and an in-memory vault. The mark is the hash of the note's bytes as the last pull
 * or save left them, kept in `.ow-seq.json` as `<id>#`; no mark (a vault from before) means the pull writes as it always did.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { ownedText } from "../vault/element-file";
import { holdsUnsavedEdits, keptEditedMessage, markKey, noteMark } from "../vault/note-mark-core";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const NOTE = `${ELEMENTS}/Character/Ireena.md`;
const SEQ = `${W}/.ow-seq.json`;
const ID = "019a0000-0000-7000-8000-0000000000f1";
const OTHER = "019a0000-0000-7000-8000-0000000000f2";

async function world() {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	return { app, vault, dl: new DownloadWorldCommand(app, {}) };
}
const el = (description: string) => ({ Character: [{ id: ID, name: "Ireena", description }] });
const index = (vault: { dotfiles: Map<string, string> }): Record<string, number> => JSON.parse(vault.dotfiles.get(SEQ) ?? "{}");
async function type(app: ReturnType<typeof makeApp>["app"], vault: { contentAt(p: string): string | undefined }, path: string, from: string, to: string) {
	await app.vault.modify(app.vault.getAbstractFileByPath(path) as never, (vault.contentAt(path) ?? "").replace(from, to));
}

test("the mark: the same bytes agree, one changed character does not, no record means no claim", () => {
	assert.equal(noteMark("a note"), noteMark("a note"));
	assert.notEqual(noteMark("a note"), noteMark("a nota"));
	assert.ok(Number.isSafeInteger(noteMark("a note ü 🙂")));
	assert.equal(holdsUnsavedEdits("a note", noteMark("a note")), false);
	assert.equal(holdsUnsavedEdits("a notf", noteMark("a note")), true);
	assert.equal(holdsUnsavedEdits("anything", undefined), false);
	assert.equal(holdsUnsavedEdits("anything", null), false);
	assert.match(keptEditedMessage(['Character "Ireena"']), /kept 1 note with unsaved edits as it is: Character "Ireena"/);
});

test("★ a pull records the note's mark; a note typed into is kept whole by the next pull, with the element named", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	assert.equal(index(vault)[markKey(ID)], noteMark(ownedText(vault.contentAt(NOTE) ?? "", "Character")), "the pull recorded no mark for the note it wrote");
	await type(app, vault, NOTE, "A noble.", "A noble, typed into by a person.");
	const typed = vault.contentAt(NOTE);
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.equal(vault.contentAt(NOTE), typed, "the pull wrote over unsaved text");
	assert.deepEqual(r.keptEdited, ['Character "Ireena"']);
	assert.ok(!r.landed.includes(ID), "a kept note is not landed: its number must not move");
	assert.ok(!r.written.includes(ID), "a kept note is not written");
});

test("a note nobody typed into is replaced by the next pull and takes a new mark", async () => {
	const { vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
	assert.deepEqual(r.keptEdited, []);
	assert.equal(index(vault)[markKey(ID)], noteMark(ownedText(vault.contentAt(NOTE) ?? "", "Character")));
});

test("a note with no mark (a vault from before) is written as it always was", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	vault.dotfiles.set(SEQ, "{}\n");
	await type(app, vault, NOTE, "A noble.", "A noble, typed into by a person.");
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
	assert.deepEqual(r.keptEdited, []);
});

test("a kept note beside a clean one: the clean one is written, the kept one named, and the pull goes on", async () => {
	const { app, vault, dl } = await world();
	const both = (a: string, b: string) => ({ Character: [{ id: ID, name: "Ireena", description: a }, { id: OTHER, name: "Kolyan", description: b }] });
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	await type(app, vault, NOTE, "A noble.", "Typed.");
	const r = await dl.generateElementNotes(ELEMENTS, both("Noble, changed.", "Priest, changed."), false);
	assert.match(vault.contentAt(`${ELEMENTS}/Character/Kolyan.md`) ?? "", /Priest, changed\./);
	assert.match(vault.contentAt(NOTE) ?? "", /Typed\./);
	assert.deepEqual(r.keptEdited, ['Character "Ireena"']);
});

test("a note the person put back as the pull left it is current again: the next pull writes it", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	await type(app, vault, NOTE, "A noble.", "Typed.");
	await type(app, vault, NOTE, "Typed.", "A noble.");
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.deepEqual(r.keptEdited, []);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
});

test("★ a person's own property in a note the world changed are the pull's to keep, not a reason to keep the note", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	await type(app, vault, NOTE, "\n---\n", "\nmy_own_property: 7\n---\n");
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.deepEqual(r.keptEdited, [], "the pull kept a note whose only edits are the person's own");
	const after = vault.contentAt(NOTE) ?? "";
	assert.match(after, /Changed on the server\./);
	assert.match(after, /my_own_property: 7/);
});

test("an edit to a property the pull would replace keeps the note, even beside the person's own text", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	await type(app, vault, NOTE, "name: Ireena", "name: Ireena Kolyana");
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.deepEqual(r.keptEdited, ['Character "Ireena"']);
	assert.match(vault.contentAt(NOTE) ?? "", /name: Ireena Kolyana/);
});
