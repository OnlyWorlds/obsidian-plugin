/**
 * An Upload claims nothing about the bytes it sent (what it sends can leave out a value the note holds), so the note's mark
 * (vault/note-mark-core.ts) is only kept where it still matches the note: no one typed into the note since the pull or save that
 * wrote it, and the next Download has nothing to copy. A note typed into since, or with no mark, loses it, as before.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessUpload } from "./support/upload-harness";
import { markKey, noteMark } from "../vault/note-mark-core";

const A = "019f0000-0000-7000-8000-0000000000a1";
const B = "019f0000-0000-7000-8000-0000000000a2";
const C = "019f0000-0000-7000-8000-0000000000a3";
const HIDDEN = "019f0000-0000-7000-8000-0000000000a4";
const note = (id: string, name: string, extra = "") => `---\nname: ${name}\nid: ${id}\n${extra}---\n\n### Description\n\nA city.\n`;
const up = (id: string, seq: number) => ({ op: "upsert", type: "location", id, change_seq: seq, element: { id, name: "x" } });

test("★ Upload keeps the mark of a note still as the last pull or save left it, and clears the mark of one typed into since", async () => {
	const akragas = note(A, "Akragas");
	const gela = note(B, "Gela");
	const r = await harnessUpload({
		notes: { "Location/Akragas.md": akragas, "Location/Gela.md": gela },
		changes: [up(A, 4), up(B, 5)],
		// Akragas: the mark is its bytes. Gela: the mark is the bytes before a person typed.
		seqs: { [A]: 4, [B]: 5, [markKey(A)]: noteMark(akragas), [markKey(B)]: noteMark(gela.replace("A city.", "A town.")) },
		answerSeq: () => 10,
	});
	assert.ok(r.patches[A] && r.patches[B], "both notes are sent: " + JSON.stringify(r.calls));
	assert.equal(r.seqIndex[markKey(A)], noteMark(akragas), "the unedited note's mark did not survive the upload: " + JSON.stringify(r.seqIndex));
	assert.equal(markKey(B) in r.seqIndex, false, "a note typed into since kept a mark it no longer matches: " + JSON.stringify(r.seqIndex));
});

test("★ a note typed into after the pull, holding a value the upload cannot send (another plugin's coordinates), is never marked", async () => {
	const pulled = note(A, "Akragas");
	const typed = note(A, "Akragas", "parent_location: [12.3, 45.6]\n");
	const r = await harnessUpload({
		notes: { "Location/Akragas.md": typed },
		changes: [up(A, 4)],
		seqs: { [A]: 4, [markKey(A)]: noteMark(pulled) },
		answerSeq: () => 10,
	});
	assert.ok(r.patches[A], JSON.stringify(r.calls));
	assert.equal(markKey(A) in r.seqIndex, false, "the coordinates were never sent and the pull would write over them with no copy: " + JSON.stringify(r.seqIndex));
});

test("a note with no mark, a created note and a note a stale write refused claim nothing new", async () => {
	const stale = note(C, "Kamarina");
	const r = await harnessUpload({
		notes: { "Location/Akragas.md": note(A, "Akragas"), "Location/Gela.md": note(B, "Gela"), "Location/Kamarina.md": stale },
		changes: [up(A, 4), up(C, 6)],
		seqs: { [A]: 4, [C]: 6, [markKey(C)]: 777 },
		stale: [C],
		answerSeq: () => 10,
	});
	assert.ok(r.patches[A] && r.bulkSent.some((e) => e.id === B), JSON.stringify(r.calls));
	assert.equal(markKey(A) in r.seqIndex, false, "a note with no mark was marked: " + JSON.stringify(r.seqIndex));
	assert.equal(markKey(B) in r.seqIndex, false, "a created note was marked: " + JSON.stringify(r.seqIndex));
	assert.equal(r.seqIndex[markKey(C)], 777, "a refused write changed the mark it had: " + JSON.stringify(r.seqIndex));
});

test("★ a note whose upload stripped a link (to an element hidden by the world's owner) loses its mark though nobody typed: the world loses the link, so the pull must copy", async () => {
	const linked = note(A, "Akragas", `parent_location: ${HIDDEN}\n`);
	const plain = note(B, "Gela");
	const r = await harnessUpload({
		notes: { "Location/Akragas.md": linked, "Location/Gela.md": plain },
		changes: [up(A, 4), up(B, 5)],
		hidden: [HIDDEN],
		seqs: { [A]: 4, [B]: 5, [markKey(A)]: noteMark(linked), [markKey(B)]: noteMark(plain) },
		answerSeq: () => 10,
	});
	assert.ok(r.patches[A] && r.patches[B], JSON.stringify(r.calls) + r.notices.join(" | "));
	assert.equal("parent_location" in r.patches[A], false, "the hidden link was sent: " + JSON.stringify(r.patches[A]));
	assert.equal(markKey(A) in r.seqIndex, false, "a note whose link the upload took out kept its mark: " + JSON.stringify(r.seqIndex));
	assert.equal(r.seqIndex[markKey(B)], noteMark(plain), "the whole note beside it lost its mark: " + JSON.stringify(r.seqIndex));
});
