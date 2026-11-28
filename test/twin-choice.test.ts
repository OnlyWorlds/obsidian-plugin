/**
 * A note an older plugin wrote may hold a text field of the person's own twice. Where the two differ nothing is guessed:
 * auto-sync refuses the note, and Save element asks the person which text to keep. The whole note goes to Kept edits/
 * before the other copy is removed, and the save then runs on the repaired note like on any other.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { harnessSave, type HarnessOpts } from "./support/save-harness";

const ID = "0199c000-0000-7000-8000-0000000000c2";
const NOTE = "Character/Ireena.md";
const note = (property: string, section: string) =>
	`---\nname: Ireena\nid: ${ID}\n# my comment\nx_mood: ${property}\nmine: 007\n---\n\n### Description\n\nA noble.\n\n### Mood\n\n${section}\n\n### Reputation\n\nKnown.\n`;
const server = () => ({ [ID]: { name: "Ireena", description: "A noble.", reputation: "Known.", x_mood: "calm", x_properties: { mine: "007" }, change_seq: 5 } });

async function save(n: string, extra: Partial<HarnessOpts> = {}) {
	const r = await harnessSave({ notes: { [NOTE]: n }, save: NOTE, server: server(), seqs: { [ID]: 5 }, ...extra });
	const after = await r.app.vault.read(r.files[NOTE] as TFile);
	const kept: string[] = [];
	for (const f of r.app.vault.getMarkdownFiles()) if (f.path.includes("/Kept edits/")) kept.push(await r.app.vault.read(f));
	return { ...r, after, kept };
}
const refused = (r: Awaited<ReturnType<typeof save>>, was: string) => {
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.equal(r.after, was, "the note is not touched");
	assert.equal(r.kept.length, 0, "nothing was replaced, so nothing is copied");
};

test("★ keep the section: the note is copied whole, the property goes, the section's text is sent", async () => {
	const was = note("calm", "angry");
	const r = await save(was, { twin: "section" });
	assert.equal(r.sent[0]?.x_mood, "angry", r.notices.join(" | "));
	assert.equal(r.after, was.replace("x_mood: calm\n", ""), "only the property's line goes");
	assert.equal(r.kept.length, 1);
	assert.equal(r.kept[0], was.replace(`id: ${ID}`, `kept_from: ${ID}`));
});

test("★ keep the property: the section goes, the property's text is sent, every other section stays", async () => {
	const was = note("gloomy", "angry");
	const r = await save(was, { twin: "property" });
	assert.equal(r.sent[0]?.x_mood, "gloomy", r.notices.join(" | "));
	assert.equal(r.after, was.replace("### Mood\n\nangry\n\n", ""));
	assert.equal(r.kept.length, 1);
	assert.match(r.kept[0], /### Mood\n\nangry\n/);
});

test("★ Windows line endings: keep the section removes one line, keep the property removes one section", async () => {
	for (const [keep, gone] of [["section", "x_mood: calm\r\n"], ["property", "### Mood\r\n\r\nangry\r\n\r\n"]] as const) {
		const was = note("calm", "angry").replace(/\n/g, "\r\n");
		const r = await save(was, { twin: keep });
		assert.equal(r.after, was.replace(gone, ""), keep);
	}
});

test("★ closing the question changes nothing and sends nothing", async () => {
	const was = note("calm", "angry");
	refused(await save(was, { twin: "cancel" }), was);
});

test("★ auto-sync never asks: it refuses, and says Save element asks", async () => {
	const was = note("calm", "angry");
	const r = await save(was, { twin: "section", manual: false });
	refused(r, was);
	assert.ok(r.notices.some((n) => n.includes("x_mood") && n.includes("Save element")), r.notices.join(" | "));
});

test("★ an emptied section is sent only when the person picks it, with the old text in the copy", async () => {
	const was = note("the only long text", "");
	const asked = await save(was, { twin: "cancel" });
	refused(asked, was);
	const r = await save(was, { twin: "section" });
	assert.equal(r.sent[0]?.x_mood, "");
	assert.match(r.kept[0], /the only long text/);
});

test("★ a note changed while the question is open is left as it is", async () => {
	const was = note("calm", "angry");
	const typed = was.replace("angry", "furious");
	const r = await save(was, { twin: "section", whileAsked: async ({ app, files }) => { await app.vault.modify(files[NOTE], typed); } });
	assert.equal(r.sent.length, 0);
	assert.equal(r.after, typed);
});

test("★ a copy that cannot be written leaves the note as it is", async () => {
	const was = note("calm", "angry");
	const r = await save(was, { twin: "section", whileAsked: async ({ app }) => { app.vault.create = async () => { throw new Error("disk full"); }; } });
	assert.equal(r.sent.length, 0);
	assert.equal(r.after, was);
	assert.ok(r.notices.some((n) => n.includes("disk full")), r.notices.join(" | "));
});

test("a property that is no text offers the section only", async () => {
	const was = note("[a, b]", "angry");
	refused(await save(was, { twin: "property" }), was);
	const r = await save(was, { twin: "section" });
	assert.equal(r.sent[0]?.x_mood, "angry", r.notices.join(" | "));
});

test("two doubled keys: both are asked before anything is written, and a cancel at the second changes nothing", async () => {
	const was = note("calm", "angry").replace("mine: 007", "x_tone: low\nmine: 007") + "\n### Tone\n\nhigh\n";
	const r = await save(was, { twin: ["section", "cancel"] });
	refused(r, was);
});
