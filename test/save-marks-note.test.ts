/**
 * A save that lands leaves the note's mark (vault/note-mark-core.ts) at the bytes it sent, so the next pull of the same
 * note, with the world changed again, does not take the saved text for unsaved edits and keep the note for good.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";
import { groupMarkKey, markKey, noteMark, valueMark } from "../vault/note-mark-core";

const ID = "0199c000-0000-7000-8000-0000000000b2";
const NOTE = `---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nA noble, edited.\n`;
const SEQ_FILE = "OnlyWorlds/Worlds/W/.ow-seq.json";
const seqOf = (r: { vault: { dotfiles: Map<string, string> } }): Record<string, number> => JSON.parse(r.vault.dotfiles.get(SEQ_FILE) ?? "{}");
const bytesOf = (r: { vault: { files: Map<string, { content: string }> } }) => [...r.vault.files.entries()].find(([p]) => p.endsWith("Character/Ireena.md"))?.[1].content ?? "";

test("★ a save that sends the edit marks the note at the bytes it holds now", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": NOTE, "~/.ow-seq.json": JSON.stringify({ [ID]: 5, [markKey(ID)]: 1 }) },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: { id: ID, change_seq: 6 } },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), "the mark is not the saved note's: " + JSON.stringify(seqOf(r)));
});

test("a save that finds the note equal to the world marks it too", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": NOTE, "~/.ow-seq.json": JSON.stringify({ [ID]: 5 }) },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble, edited.", change_seq: 5 } },
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)));
});

const GROUP_NOTE = `---\nname: Ireena\nid: ${ID}\nkeepme: one\ndropme: two\n---\n\n### Description\n\nA noble, edited.\n`;

test("★ a save marks each entry of the group the answer holds, at the value the note holds, and clears a mark the answer no longer holds", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": GROUP_NOTE, "~/.ow-seq.json": JSON.stringify({ [ID]: 5, [groupMarkKey(ID, "old")]: 9 }) },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: { id: ID, change_seq: 6, x_properties: { keepme: "one", dropme: "two" } } },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	const idx = seqOf(r);
	assert.equal(idx[groupMarkKey(ID, "keepme")], valueMark("one"), JSON.stringify(idx));
	assert.equal(idx[groupMarkKey(ID, "dropme")], valueMark("two"), JSON.stringify(idx));
	assert.ok(!(groupMarkKey(ID, "old") in idx), "a mark for an entry the answer no longer holds stayed: " + JSON.stringify(idx));
});
