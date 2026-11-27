/**
 * A pull drops an entry of the world's group that another client removed (the group marks, vault/note-mark-core.ts),
 * and only that: a property a person typed, one they changed since the pull, and one no mark covers all stay in the note.
 * Through the real DownloadWorldCommand note writer and an in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { groupKeysById, groupMarkClears, groupMarkEntries, groupMarkKey, removedGroupKeys, valueMark } from "../vault/note-mark-core";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const NOTE = `${ELEMENTS}/Character/Ireena.md`;
const SEQ = `${W}/.ow-seq.json`;
const ID = "019a0000-0000-7000-8000-0000000000f1";

async function world() {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	return { app, vault, dl: new DownloadWorldCommand(app, {}) };
}
const el = (group: Record<string, unknown> | undefined, description = "A noble.") => ({
	Character: [{ id: ID, name: "Ireena", description, ...(group ? { x_properties: group } : {}) }],
});
const index = (vault: { dotfiles: Map<string, string> }): Record<string, number> => JSON.parse(vault.dotfiles.get(SEQ) ?? "{}");
async function edit(app: ReturnType<typeof makeApp>["app"], vault: { contentAt(p: string): string | undefined }, from: string, to: string) {
	const text = vault.contentAt(NOTE) ?? "";
	assert.ok(text.includes(from), `the note holds no ${from}`);
	await app.vault.modify(app.vault.getAbstractFileByPath(NOTE) as never, text.replace(from, to));
}

test("the core: a removed, unchanged, marked key is named; typed, changed and unmarked keys never are", () => {
	const idx = { [groupMarkKey(ID, "a")]: valueMark("one"), [groupMarkKey(ID, "b")]: valueMark("two") };
	assert.deepEqual(removedGroupKeys(ID, { b: "two" }, { a: "one", b: "two", c: "mine" }, idx), ["a"]);
	assert.deepEqual(removedGroupKeys(ID, { b: "two" }, { a: "one edited", b: "two" }, idx), [], "a value the person changed is theirs");
	assert.deepEqual(removedGroupKeys(ID, null, { a: "one", b: "two" }, idx), ["a", "b"], "an element whose group was cleared removed both");
	assert.deepEqual(removedGroupKeys(ID, undefined, { a: "one", b: "two" }, idx), [], "no x_properties key at all is no news");
	assert.deepEqual(removedGroupKeys(ID, { a: "one" }, { a: "one" }, {}), [], "no mark, no claim");
	assert.deepEqual(removedGroupKeys("other-id", {}, { a: "one" }, idx), [], "another id's marks are not this note's");
});

test("the core: marks follow the group the note holds, and clear what it no longer holds", () => {
	const idx = { [groupMarkKey(ID, "gone")]: 5, [groupMarkKey("x", "k")]: 7 };
	const known = groupKeysById(idx);
	const out = groupMarkEntries(ID, { a: "one", missing: "x" }, { a: "one" }, known);
	assert.equal(out[groupMarkKey(ID, "a")], valueMark("one"));
	assert.equal(out[groupMarkKey(ID, "gone")], null);
	assert.ok(!(groupMarkKey(ID, "missing") in out), "a key the note does not hold gets no mark");
	assert.ok(!(groupMarkKey("x", "k") in out), "another id's mark is left alone");
	assert.deepEqual(groupMarkClears(ID, known), { [groupMarkKey(ID, "gone")]: null });
	// a key the writer kept inside the note's own x_properties (the person's own `tags` stays theirs) gets no mark
	const taken = groupMarkEntries(ID, { tags: "world" }, { tags: ["npc"], x_properties: { tags: "world" } }, new Map());
	assert.deepEqual(taken, {});
});

test("★ a group entry another client removed leaves the note at the pull, and the next pull keeps the others", async () => {
	const { vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el({ keepme: "one", dropme: "two" }), false);
	assert.match(vault.contentAt(NOTE) ?? "", /dropme: two/);
	assert.equal(index(vault)[groupMarkKey(ID, "dropme")], valueMark("two"), "the pull recorded no mark for the entry");
	await dl.generateElementNotes(ELEMENTS, el({ keepme: "one" }, "Changed on the server."), false);
	const after = vault.contentAt(NOTE) ?? "";
	assert.doesNotMatch(after, /dropme/, "the removed entry stayed in the note");
	assert.match(after, /keepme: one/);
	assert.equal(groupMarkKey(ID, "dropme") in index(vault), false, "the mark of a removed entry stayed in the index");
});

test("a group removed whole leaves the note too", async () => {
	const { vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el({ a: "1", b: "2" }), false);
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Changed.", x_properties: null }] }, false);
	const after = vault.contentAt(NOTE) ?? "";
	assert.match(after, /Changed\./);
	assert.doesNotMatch(after, /^a: /m);
	assert.doesNotMatch(after, /^b: /m);
});

test("★ a property the person typed is kept when the group changes; so is one whose value they changed", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el({ keepme: "one", dropme: "two" }), false);
	await edit(app, vault, "\n---\n", "\nmine: typed by hand\n---\n");
	await edit(app, vault, "dropme: two", "dropme: two, but mine now");
	await dl.generateElementNotes(ELEMENTS, el({ keepme: "one" }, "Changed on the server."), false);
	const after = vault.contentAt(NOTE) ?? "";
	assert.match(after, /mine: typed by hand/);
	assert.match(after, /dropme: two, but mine now/);
});

test("a note with no group marks (a vault from before) keeps every property, as it always did", async () => {
	const { vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el({ keepme: "one", dropme: "two" }), false);
	vault.dotfiles.set(SEQ, "{}\n");
	await dl.generateElementNotes(ELEMENTS, el({ keepme: "one" }, "Changed on the server."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /dropme: two/);
});

test("a number or a list value is marked and dropped by what the note holds, not by how it was sent", async () => {
	const { vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el({ n: 7, l: ["a", "b"], keep: "k" }), false);
	await dl.generateElementNotes(ELEMENTS, el({ keep: "k" }, "Changed."), false);
	const after = vault.contentAt(NOTE) ?? "";
	assert.doesNotMatch(after, /^n: 7$/m);
	assert.doesNotMatch(after, /^l:/m);
	assert.match(after, /keep: k/);
});

test("an element that arrives with no x_properties key at all is no news: the entries stay", async () => {
	const { vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el({ a: "1" }), false);
	await dl.generateElementNotes(ELEMENTS, el(undefined, "Changed."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /^a: /m);
});

test("a property the person owns under a name the group also uses is never marked, so a removal never takes it", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el(undefined), false);
	await edit(app, vault, "\n---\n", "\ntags:\n  - npc\n---\n");
	await dl.generateElementNotes(ELEMENTS, el({ tags: "world" }, "Changed."), false);
	assert.equal(groupMarkKey(ID, "tags") in index(vault), false, "the person's own tags was marked as the world's");
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Changed.", x_properties: null }] }, false);
	assert.match(vault.contentAt(NOTE) ?? "", /npc/);
});
