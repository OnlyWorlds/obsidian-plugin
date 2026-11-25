/**
 * A note that loses its last own property: Save clears the world's group (the Markdown profile, sentence 4),
 * through the real SaveElementCommand and an in-memory vault and server. The clearing rides only on a note whose
 * change_seq is known, so it is sent under If-Match and a group the note never held is not removed.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";
import { apiDataToFrontmatter, groupUnseen, withGroupCleared } from "../vault/element-transform";
import { unseenKey } from "../vault/change-seq-index";

const ID = "0199c000-0000-7000-8000-0000000000b1";

const note = (fm: string) => `---\nname: Ireena\nid: ${ID}\n${fm}---\n\n### Description\n\nA noble.\n`;
const SEQ_INDEX = { "~/.ow-seq.json": JSON.stringify({ [ID]: 5 }) };
const held = (group: unknown, seq = 5) => ({ [ID]: { name: "Ireena", description: "A noble.", change_seq: seq, x_properties: group } });

test("★ the last own property deleted in a note whose seq is known: the save clears the group", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(r.sent[0].x_properties, null);
});

test("a note that keeps an entry of the group (its own x_properties) sends the group with it, never null", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("x_properties:\n  kept: 1\n"), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: held({ status: "draft", kept: 1 }),
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.deepEqual(r.sent[0].x_properties, { kept: 1 });
});

test("a note with no seq known never clears a group it may not have held", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("") },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /already up to date/.test(n)), r.notices.join(" | "));
});

test("an element that moved since the note was pulled is refused as stale, the group untouched", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }, 6),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
});

test("a note and an element with no group at all: nothing is sent", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /already up to date/.test(n)), r.notices.join(" | "));
});

test("withGroupCleared adds the clearing only when guarded and only when the payload holds no group", () => {
	assert.deepEqual(withGroupCleared({ name: "A" }, true), { name: "A", x_properties: null });
	assert.deepEqual(withGroupCleared({ name: "A" }, false), { name: "A" });
	assert.deepEqual(withGroupCleared({ name: "A", x_properties: { k: 1 } }, true), { name: "A", x_properties: { k: 1 } });
});

test("the pull of an element whose group the world has cleared writes no x_properties line", () => {
	const fm = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: null }, "character", ID);
	assert.equal("x_properties" in fm, false, JSON.stringify(fm));
	const empty = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: {} }, "character", ID);
	assert.equal("x_properties" in empty, false, JSON.stringify(empty));
});

const SEQ_FILE = "OnlyWorlds/Worlds/W/.ow-seq.json";
const seqOf = (r: { vault: { dotfiles: Map<string, string> } }): Record<string, number> => JSON.parse(r.vault.dotfiles.get(SEQ_FILE) ?? "{}");

test("★ an unchanged save that leaves a group in the world the note never held records the number and flags it, so the next save cannot clear it", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("") },
		save: "Character/Ireena.md",
		server: held({ name: "kept" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.equal(seqOf(r)[ID], 5, "the number still guards the note");
	assert.equal(seqOf(r)[unseenKey(ID)], 1, JSON.stringify(seqOf(r)));
});

test("control: the same unchanged save with no group in the world records the number", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("") },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
	});
	assert.equal(seqOf(r)[ID], 5);
	assert.equal(unseenKey(ID) in seqOf(r), false, "no flag when the world holds no group");
});

test("an edit sent while the world holds a group the note never held records the answer's number and flags it", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("").replace("A noble.", "A noble, changed.") },
		save: "Character/Ireena.md",
		server: held({ name: "kept" }),
		answer: { [ID]: { id: ID, change_seq: 6, x_properties: { name: "kept" } } },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal("x_properties" in r.sent[0], false, "no clearing without a known number");
	assert.equal(seqOf(r)[ID], 6, JSON.stringify(seqOf(r)));
	assert.equal(seqOf(r)[unseenKey(ID)], 1, JSON.stringify(seqOf(r)));
});

test("Upload records the answer's number and flags it when the answer leaves a group in the world the note never held", async () => {
	const { harnessUpload } = await import("./support/upload-harness");
	const loc = `---\nname: Akragas\nid: ${ID}\n---\n\n### Description\n\nA city.\n`;
	const r = await harnessUpload({
		notes: { "Location/Akragas.md": loc },
		changes: [{ op: "upsert", type: "location", id: ID, change_seq: 4, element: { id: ID, name: "x" } }],
		answerSeq: () => 9,
		answerGroup: () => ({ name: "kept" }),
	});
	assert.ok(r.patches[ID], "the note is sent");
	assert.equal(r.seqIndex[ID], 9, JSON.stringify(r.seqIndex));
	assert.equal(r.seqIndex[unseenKey(ID)], 1, JSON.stringify(r.seqIndex));
});

test("groupUnseen is true only for a payload with no group beside a world element that holds a non-empty one", () => {
	assert.equal(groupUnseen({ name: "A" }, { x_properties: { k: 1 } }), true);
	assert.equal(groupUnseen({ name: "A" }, { x_properties: {} }), false);
	assert.equal(groupUnseen({ name: "A" }, { x_properties: null }), false);
	assert.equal(groupUnseen({ name: "A" }, {}), false);
	assert.equal(groupUnseen({ name: "A", x_properties: { k: 1 } }, { x_properties: { k: 1 } }), false);
	assert.equal(groupUnseen({ name: "A" }, undefined), false);
});

test("★ a flagged note whose number is current never clears the group: nothing is sent", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), "~/.ow-seq.json": JSON.stringify({ [ID]: 5, [unseenKey(ID)]: 1 }) },
		save: "Character/Ireena.md",
		server: held({ name: "kept" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /already up to date/.test(n)), r.notices.join(" | "));
});

test("a flagged note's number still refuses a stale save: the protection the number gives is kept", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("").replace("A noble.", "A noble, changed."), "~/.ow-seq.json": JSON.stringify({ [ID]: 5, [unseenKey(ID)]: 1 }) },
		save: "Character/Ireena.md",
		server: held({ name: "kept" }, 6),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /changed on onlyworlds.com since this note was pulled/.test(n)), r.notices.join(" | "));
});

test("a type entry in the world's group that repeats the note's own type stays in the group, so a save sends it back", () => {
	const fm = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: { type: "Character", mood: "tense" } }, "character", ID);
	assert.deepEqual(fm.x_properties, { type: "Character" });
	assert.equal(fm.mood, "tense");
	assert.equal("type" in fm, false, JSON.stringify(fm));
});
