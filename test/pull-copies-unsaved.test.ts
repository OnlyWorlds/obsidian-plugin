/**
 * A pull copies a note that holds edits it had not seen into `Kept edits/` before it writes the world's copy (the note mark,
 * vault/note-mark-core.ts), through the real DownloadWorldCommand note writer and an in-memory vault. The mark is the hash of
 * the note's whole bytes as the last pull or save left them, kept in `.ow-seq.json` as `<id>#`; no mark (a vault from before)
 * means the pull writes as it always did. The copy has no `id` key (`kept_from` instead), so no reader takes it for the element.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { asKeptCopy, copiedMessage, holdsUnsavedEdits, keptCopyName, markKey, noteMark } from "../vault/note-mark-core";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const NOTE = `${ELEMENTS}/Character/Ireena.md`;
const SEQ = `${W}/.ow-seq.json`;
const KEPT = `${W}/Kept edits/`;
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
const copies = (vault: { files: Map<string, unknown> }) => [...vault.files.keys()].filter((p) => p.startsWith(KEPT));
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
	assert.match(copiedMessage(['Character "Ireena"']), /over 1 note that held edits it had not seen: Character "Ireena"\. The note as it was is kept whole in Kept edits\//);
});

test("the copy: the front matter's id key becomes kept_from, every other byte stays, a body line that starts with id: is not touched", () => {
	const note = `---\nname: Ireena\nid: ${ID}\n---\n\nid: not a key\n`;
	assert.equal(asKeptCopy(note), `---\nname: Ireena\nkept_from: ${ID}\n---\n\nid: not a key\n`);
	assert.equal(asKeptCopy(note.replace(/\n/g, "\r\n")), `---\r\nname: Ireena\r\nkept_from: ${ID}\r\n---\r\n\r\nid: not a key\r\n`);
	assert.equal(asKeptCopy("no front matter\nid: x\n"), "no front matter\nid: x\n");
	assert.equal(keptCopyName("Ireena", new Date(2026, 10, 26, 20, 6)), "Ireena (kept 2026-11-26 2006)");
});

test("★ a pull copies a note typed into, whole and with no id, then writes the world's copy; the element is named", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	assert.equal(index(vault)[markKey(ID)], noteMark(vault.contentAt(NOTE) ?? ""), "the pull recorded no mark for the note it wrote");
	await type(app, vault, NOTE, "A noble.", "A noble, typed into by a person.");
	const typed = vault.contentAt(NOTE) ?? "";
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./, "the world's copy was not written");
	assert.deepEqual(r.copied, ['Character "Ireena"']);
	const made = copies(vault);
	assert.equal(made.length, 1, JSON.stringify(made));
	assert.match(made[0], /Kept edits\/Ireena \(kept \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
	const copy = vault.contentAt(made[0]) ?? "";
	assert.equal(copy, asKeptCopy(typed), "the copy is not the note as it was, byte for byte but the id key");
	assert.match(copy, /A noble, typed into by a person\./);
	assert.doesNotMatch(copy, /^id:/m, "the copy still carries an id: a reader would take it for the element");
	assert.match(copy, new RegExp(`^kept_from: ${ID}$`, "m"));
});

test("a note nobody typed into is replaced with no copy, and takes a new mark", async () => {
	const { vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
	assert.deepEqual(r.copied, []);
	assert.deepEqual(copies(vault), []);
	assert.equal(index(vault)[markKey(ID)], noteMark(vault.contentAt(NOTE) ?? ""));
});

test("a note with no mark (a vault from before) is written as it always was, with no copy", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	vault.dotfiles.set(SEQ, "{}\n");
	await type(app, vault, NOTE, "A noble.", "A noble, typed into by a person.");
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
	assert.deepEqual(r.copied, []);
	assert.deepEqual(copies(vault), []);
});

test("a note beside a clean one: only the typed one is copied, both are written, the pull goes on", async () => {
	const { app, vault, dl } = await world();
	const both = (a: string, b: string) => ({ Character: [{ id: ID, name: "Ireena", description: a }, { id: OTHER, name: "Kolyan", description: b }] });
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	await type(app, vault, NOTE, "A noble.", "Typed.");
	const r = await dl.generateElementNotes(ELEMENTS, both("Noble, changed.", "Priest, changed."), false);
	assert.match(vault.contentAt(`${ELEMENTS}/Character/Kolyan.md`) ?? "", /Priest, changed\./);
	assert.match(vault.contentAt(NOTE) ?? "", /Noble, changed\./);
	assert.deepEqual(r.copied, ['Character "Ireena"']);
	assert.equal(copies(vault).length, 1);
});

test("a note the person put back as the pull left it is current again: no copy", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	await type(app, vault, NOTE, "A noble.", "Typed.");
	await type(app, vault, NOTE, "Typed.", "A noble.");
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.deepEqual(r.copied, []);
	assert.deepEqual(copies(vault), []);
});

test("★ text of the person's own, in any place a pull writes over, is in the copy: an own section, an edit inside a custom section, prose above the first heading", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	await type(app, vault, NOTE, "\n---\n", "\n---\n\nProse above the first heading.\n");
	const text = (vault.contentAt(NOTE) ?? "") + "\n### My notes\n\nMy own section.\n";
	await app.vault.modify(app.vault.getAbstractFileByPath(NOTE) as never, text);
	await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	const copy = vault.contentAt(copies(vault)[0]) ?? "";
	assert.match(copy, /Prose above the first heading\./);
	assert.match(copy, /### My notes\n\nMy own section\./);
});

test("a second copy of the same note in the same minute gets its own name; neither is written over", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	await type(app, vault, NOTE, "A noble.", "First typing.");
	await dl.generateElementNotes(ELEMENTS, el("Changed once."), false);
	await type(app, vault, NOTE, "Changed once.", "Second typing.");
	await dl.generateElementNotes(ELEMENTS, el("Changed twice."), false);
	const made = copies(vault);
	assert.equal(made.length, 2, JSON.stringify(made));
	assert.ok(made.some((p) => /First typing\./.test(vault.contentAt(p) ?? "")));
	assert.ok(made.some((p) => /Second typing\./.test(vault.contentAt(p) ?? "")));
});
