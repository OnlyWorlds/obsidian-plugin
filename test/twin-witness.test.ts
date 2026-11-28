/**
 * A note 3.23.2 wrote holds a string x_ key twice, and its Save leaves the property as it was. Save settles such a note by
 * one witness only: the world's copy at the note's own change number. Where the property still equals it, the property
 * holds no edit, so the section is the edit. Every other difference is refused, because a property that differs from the
 * world is the ordinary leftover of a saved section edit.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { harnessSave, type HarnessOpts } from "./support/save-harness";
import { V2ApiError } from "../client-v2";
import { markKey } from "../vault/note-mark-core";
import { readChangeSeqIndex } from "../vault/change-seq-index";

const ID = "0199c000-0000-7000-8000-0000000000c2";
const NOTE = "Character/Ireena.md";
const note = (property: string, section: string) =>
	`---\nname: Ireena\nid: ${ID}\n# my comment\n${property}\nmine: 007\n---\n\n### Description\n\nA noble.\n\n### Mood\n\n${section}\n`;
const text = { name: "Ireena", description: "A noble.", x_properties: { mine: "007" } };
const world = (x_mood: unknown, seq = 5) => ({ [ID]: { ...text, ...(x_mood === undefined ? {} : { x_mood }), change_seq: seq } });

async function save(n: string, server: Record<string, Record<string, unknown>>, extra: Partial<HarnessOpts> = {}) {
	const r = await harnessSave({ notes: { [NOTE]: n }, save: NOTE, server, seqs: { [ID]: 5 }, ...extra });
	const after = await r.app.vault.read(r.files[NOTE] as TFile);
	return { ...r, after };
}
const refused = (r: { sent: unknown[]; notices: string[]; after: string }, was: string) => {
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => n.includes("x_mood") && n.includes("both a property of the note and a ### section")), r.notices.join(" | "));
	assert.equal(r.after, was, "a refused note is not touched");
};

test("★ the property still equals the world: the section is sent, and the note holds the key once", async () => {
	const r = await save(note("x_mood: calm", "angry"), world("calm"));
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(r.sent[0].x_mood, "angry");
	assert.equal(r.after, note("x_mood: calm", "angry").replace("x_mood: calm\n", ""), "only the property's line goes");
});

test("★ the leftover of a saved section edit (section equals the world, property old) is refused: the old text is never sent", async () => {
	const was = note("x_mood: calm", "angry");
	refused(await save(was, world("angry")), was);
});

test("both differ from the world: refused", async () => {
	const was = note("x_mood: calm", "furious");
	refused(await save(was, world("angry")), was);
});

test("★ no change number on the note, or a world that moved past it: the world is no witness", async () => {
	const was = note("x_mood: calm", "angry");
	refused(await save(was, world("calm"), { seqs: undefined }), was);
	refused(await save(was, world("calm", 6)), was);
});

test("a world without the key, or holding it as no text, is no witness", async () => {
	const was = note("x_mood: calm", "angry");
	refused(await save(was, world(undefined)), was);
	refused(await save(was, world(["calm"])), was);
});

test("★ an element the server answers 404 for is not created from a doubled note", async () => {
	const was = note("x_mood: calm", "angry");
	const r = await save(was, {});
	refused(r, was);
	assert.ok(!r.calls.some((c) => c.startsWith("create") || c === "bulk"), r.calls.join(","));
});

test("a send the server refuses leaves the property in the note", async () => {
	const was = note("x_mood: calm", "angry");
	const r = await save(was, world("calm"), { during: async () => { throw new V2ApiError(412, "stale_write", "API Error 412", null); } });
	assert.equal(r.sent.length, 1);
	assert.equal(r.after, was);
});

test("★ a property typed over while the save runs is kept", async () => {
	const was = note("x_mood: calm", "angry");
	const typed = was.replace("x_mood: calm", "x_mood: gloomy");
	const r = await save(was, world("calm"), { during: async ({ app, files }) => { await app.vault.modify(files[NOTE], typed); } });
	assert.equal(r.sent.length, 1);
	assert.equal(r.after, typed);
});

test("Windows line endings stay: only the property's line goes", async () => {
	const was = note("x_mood: calm", "angry").replace(/\n/g, "\r\n");
	const r = await save(was, world("calm"));
	assert.equal(r.sent[0]?.x_mood, "angry", r.notices.join(" | "));
	assert.equal(r.after, was.replace("x_mood: calm\r\n", ""));
});

test("★ the settled note takes a second section edit, and is marked as the world's where the answer is whole", async () => {
	const full = { physicality: "", mentality: "", background: "", motivations: "", reputation: "" };
	const answer = { id: ID, ...text, ...full, x_mood: "angry", change_seq: 6 };
	const first = await save(note("x_mood: calm", "angry"), world("calm"), { answer: { [ID]: answer } });
	const index = await readChangeSeqIndex(first.app, "W");
	assert.equal(index[ID], 6);
	const second = await save(first.after.replace("angry", "furious"), world("angry", 6), { seqs: { [ID]: 6 } });
	assert.equal(second.sent[0]?.x_mood, "furious", second.notices.join(" | "));
	assert.ok(markKey(ID));
});
