/**
 * The rules that replace guessing (round 6): an old span note is a note of
 * the plugin's old layout and nothing else; Copy writes over only a note it
 * marked as its own; Update never chooses between two prose copies of a
 * field; Copy and Upload read a note's identity from its own bytes; Update
 * checks each note again when the confirmed run starts. Built on a cold read's
 * reproductions; each runs through the real command and an in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __modals, __notices, type MockVault } from "./support/obsidian-mock";
import { harnessUpload } from "./support/upload-harness";
import { harnessSave } from "./support/save-harness";
import { readElement } from "../vault/element-file";
import { W, E } from "./support/four-notes";
import { MigrateWorldCommand } from "../Commands/MigrateWorldCommand";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { CopyWorldCommand, COPY_OUTPUT_MARKER } from "../Commands/CopyWorldCommand";
import { WorldService } from "../Scripts/WorldService";

const A = "019e0000-0000-7000-8000-0000000000a1";

const FIELD = (label: string, value: string, cls = "text-field", tip = "Text") =>
	`- <span class="${cls}" data-tooltip="${tip}">${label}</span>: ${value}`;

type MigrationReport = { converted: string[]; failed: { path: string; reason: string }[]; left: { path: string; reason: string }[] };
async function migrate(app: App): Promise<MigrationReport | null> {
	__modals.length = 0;
	__notices.length = 0;
	await (new MigrateWorldCommand(app) as unknown as { migrateWorld(w: string): Promise<void> }).migrateWorld("W");
	return (__modals.at(-1) as unknown as { result?: MigrationReport } | undefined)?.result ?? null;
}
async function seedAll(vault: MockVault, notes: Record<string, string>): Promise<void> {
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	for (const [p, t] of Object.entries(notes)) await vault.seed(p, t);
}
function assertUnchanged(vault: MockVault, notes: Record<string, string>): void {
	for (const [p, t] of Object.entries(notes)) assert.equal(vault.contentAt(p), t, `${p} was rewritten:\n${vault.contentAt(p)}`);
}
async function copyData(app: App): Promise<Record<string, Record<string, unknown>[]>> {
	return (await new CopyWorldCommand(app, {} as never, new WorldService(app)).collectWorldData(W)) as Record<string, Record<string, unknown>[]>;
}

// --- 1 an old span note is the plugin's old layout and nothing else ---------------------------

const WITH_EXAMPLE = [
	"## Base",
	FIELD("Id", A),
	FIELD("Name", "Bob"),
	FIELD("Description", "My actual chapter."),
	"Example: `" + FIELD("Description", "EXAMPLE ONLY") + "`",
	"",
].join("\n");

test("★ a note with old span lines and a line of anything else is the person's own: never copied, uploaded or migrated as an element", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${E}/Character/Bob.md`]: WITH_EXAMPLE };
	await seedAll(vault, notes);
	const data = await copyData(app);
	assert.deepEqual(data.Character, [], "Copy: " + JSON.stringify(data.Character));
	const up = await harnessUpload({ notes: { "Character/Bob.md": WITH_EXAMPLE }, changes: [] });
	assert.deepEqual([...up.bulkSent, ...Object.values(up.patches)], [], "Upload: " + JSON.stringify(up));
	const r = await migrate(app);
	assertUnchanged(vault, notes);
	assert.deepEqual(r?.converted ?? [], [], JSON.stringify(r));
	const named = (r?.left ?? []).some((l) => l.path === `${E}/Character/Bob.md`) || __notices.some((n) => n.includes(`${E}/Character/Bob.md`));
	assert.ok(named, "an old-looking note left without a word: " + JSON.stringify(r) + " " + __notices.join(" | "));
});

const ESCAPED = ["## Base", FIELD("Id", A), FIELD("Name", "Bob"), FIELD("Description", "Carved a literal \\` in stone."), FIELD("Physicality", "Carries a \\` shaped staff.", "string"), ""].join("\n");

test("★ an old note's every field is read, a backtick in a value included", async () => {
	const { app, vault } = makeApp();
	await seedAll(vault, { [`${E}/Character/Bob.md`]: ESCAPED });
	const data = await copyData(app);
	assert.equal(data.Character[0]?.physicality, "Carries a \\` shaped staff.", "Copy: " + JSON.stringify(data.Character));
	const up = await harnessUpload({ notes: { "Character/Bob.md": ESCAPED }, changes: [] });
	assert.equal(up.bulkSent[0]?.physicality, "Carries a \\` shaped staff.", "Upload: " + JSON.stringify(up.bulkSent));
	const r = await migrate(app);
	assert.deepEqual(r?.converted, [`${E}/Character/Bob.md`], JSON.stringify(r));
});

// --- 2 Migrate writes every field of an old note --------------------------------------------

test("★ Migrate writes every text field of an old note into its body, and one its type no longer has as a section of its own", async () => {
	const { app, vault } = makeApp();
	const path = `${E}/Character/Bob.md`;
	await seedAll(vault, {
		[path]: ["## Base", FIELD("Id", A), FIELD("Name", "Bob"), FIELD("Description", "A man."), "", "## Constitution", FIELD("Physicality", "Carries a \\` shaped staff.", "string"), FIELD("Psychology", "Restless.", "text-field"), ""].join("\n"),
	});
	const r = await migrate(app);
	assert.deepEqual(r?.converted, [path], JSON.stringify(r));
	const text = vault.contentAt(path) ?? "";
	assert.match(text, /### Physicality\n\nCarries a \\` shaped staff\./, text);
	assert.match(text, /### Psychology\n\nRestless\./, text);
	assert.match(text, /### Description\n\nA man\./, text);
});

// --- 3 Copy writes over only a note it marked as its own ---------------------------------------

function withClipboard(): void {
	Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true });
}

test("★ Copy world writes World Data File.md only when it is absent or carries Copy's own marker on its first line", async () => {
	withClipboard();
	const { app, vault } = makeApp();
	const chapter = '{"World":{"chapter":"The only copy of my chapter"}}';
	await seedAll(vault, { [`${W}/World Data File.md`]: chapter });
	const copy = new CopyWorldCommand(app, {} as never, new WorldService(app));
	__notices.length = 0;
	await copy.copyWorldData("W");
	assert.equal(vault.contentAt(`${W}/World Data File.md`), chapter, "a note Copy did not mark was overwritten");
	assert.ok(__notices.some((n) => /World Data File/.test(n) && /not overwritten/.test(n)), __notices.join(" | "));
	// absent: written, its first line the marker; then that note is Copy's to write again
	await app.vault.delete(app.vault.getAbstractFileByPath(`${W}/World Data File.md`)!);
	await copy.copyWorldData("W");
	const first = vault.contentAt(`${W}/World Data File.md`) ?? "";
	assert.equal(first.split("\n")[0], COPY_OUTPUT_MARKER, first.slice(0, 200));
	await app.vault.modify(app.vault.getAbstractFileByPath(`${W}/World Data File.md`) as TFile, `${COPY_OUTPUT_MARKER}\n{"old": true}`);
	await copy.copyWorldData("W");
	assert.doesNotMatch(vault.contentAt(`${W}/World Data File.md`) ?? "", /"old"/);
});

// --- 4 Update never chooses between two prose copies --------------------------------------------

async function update(app: App): Promise<void> {
	__notices.length = 0;
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<unknown>; apply(p: unknown): Promise<void> };
	await cmd.apply(await cmd.buildPlan("W"));
}

test("★ Update world format refuses a text property beside a section of the same field, an empty section too", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${W}/Drafts/Kai.md`]: `---\nid: ${A}\ntype: character\nname: Kai\nphysicality: "The only copy of my portrait"\n---\n\n### Description\n\nA guard.\n\n### Physicality\n\n` };
	await seedAll(vault, notes);
	await update(app);
	assertUnchanged(vault, notes);
	assert.ok(__notices.some((n) => /Kai not updated/.test(n)), __notices.join(" | "));
});

test("★ Update world format refuses a text property when the body holds prose outside every section", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${W}/Drafts/Zel.md`]: `---\nid: ${A}\ntype: character\nname: Zel\ndescription: Summary\n---\n\nMy only preamble chapter.\n\n### Description\n\nSummary\n` };
	await seedAll(vault, notes);
	await update(app);
	assertUnchanged(vault, notes);
	assert.ok(__notices.some((n) => /Zel not updated/.test(n)), __notices.join(" | "));
});

// --- 5 Copy and Upload read identity from the note's bytes --------------------------------------

test("★ Copy and Upload never take a note for an element by a stale metadata cache", async () => {
	const diary = `---\nid: false\n---\n\n### Description\n\nA new private chapter.\n`;
	const stale = { frontmatter: { id: A, name: "Diary", type: "character" } };
	const { app, vault, cache } = makeApp();
	await seedAll(vault, { [`${W}/Drafts/Diary.md`]: diary });
	const c = cache as unknown as { getFileCache(f: { path: string }): unknown };
	const get = c.getFileCache.bind(c);
	c.getFileCache = (f: { path: string }) => (f.path.endsWith("Diary.md") ? stale : get(f));
	const data = await copyData(app);
	assert.deepEqual(data.Character, [], "Copy: " + JSON.stringify(data.Character));
	const proto = (await import("./support/obsidian-mock")).MockMetadataCache.prototype as unknown as { getFileCache(f: { path: string }): unknown };
	const orig = proto.getFileCache;
	proto.getFileCache = function (this: unknown, f: { path: string }) {
		return f.path.endsWith("Diary.md") ? stale : orig.call(this, f);
	};
	try {
		const up = await harnessUpload({ notes: { "Character/Ireena.md": `---\nname: Ireena\nid: 019e0000-0000-7000-8000-0000000000b1\n---\n\n### Description\n\nA noble.\n`, "Drafts/Diary.md": diary }, changes: [] });
		const ids = [...up.bulkSent.map((e) => String(e.id)), ...Object.keys(up.patches)];
		assert.ok(!ids.includes(A), "Upload sent a note of the person's own under a stale cache's id: " + JSON.stringify(up.bulkSent));
	} finally {
		proto.getFileCache = orig;
	}
});

// --- 6 Update checks each note again when the confirmed run starts -------------------------------

test("★ Update world format leaves a note that stopped being an element after the plan was made", async () => {
	const { app, vault } = makeApp();
	const path = `${W}/Drafts/Kai.md`;
	await seedAll(vault, { [path]: `---\nid: ${A}\ntype: character\nname: Kai\n---\n\nA guard.\n` });
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<{ notes: unknown[] }>; apply(p: unknown): Promise<void> };
	const plan = await cmd.buildPlan("W");
	assert.equal(plan.notes.length, 1);
	const mine = `---\nid: false\ntype: character\nname: Kai\n---\n\nA guard.\n`;
	await app.vault.modify(app.vault.getAbstractFileByPath(path) as TFile, mine);
	__notices.length = 0;
	await cmd.apply(plan);
	assert.equal(vault.contentAt(path), mine, "a note that is no element any more was rewritten");
	assert.ok(__notices.some((n) => /Kai not updated/.test(n)), __notices.join(" | "));
});

// --- 7 text above the first section beside a Description section -------------------------------

test("★ Update world format refuses a note with text above its first section and a Description section, and names it", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${E}/Character/Pell.md`]: `---\nname: Pell\nid: ${A}\n---\n\nMy preamble, the only copy.\n\n### Description\n\nA guard.\n` };
	await seedAll(vault, notes);
	await update(app);
	assertUnchanged(vault, notes);
	assert.ok(__notices.some((n) => /Pell not updated/.test(n)), __notices.join(" | "));
});

// --- 8 Save reads a note only through the one reader: no fallback of its own ------------------

const B = "019e0000-0000-7000-8000-0000000000b2";
const RESEARCH = [
	"Private research.",
	"",
	"```markdown",
	"## Base",
	FIELD("Id", A),
	FIELD("Name", "Example"),
	FIELD("Description", "EXAMPLE ONLY"),
	"```",
	"",
	"My conclusion.",
	"",
].join("\n");
const BOB = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nBob's real chapter.\n`;
const OLD = (id: string, name: string, description: string) => ["## Base", FIELD("Id", id), FIELD("Name", name), FIELD("Description", description), ""].join("\n");

test("★ Save sends nothing for a note of the person's own that quotes old span markup, by auto-sync or by hand", async () => {
	const notes = { "Character/Research.md": RESEARCH, "Character/Bob.md": BOB };
	const server = { [A]: { name: "Bob", description: "Bob's real chapter." } };
	const auto = await harnessSave({ notes, save: "Character/Research.md", server, manual: false });
	assert.deepEqual(auto.calls, [], "auto-sync called the server for a note of the person's own: " + auto.calls.join(" | "));
	assert.deepEqual(auto.sent, []);
	assert.deepEqual(auto.notices, [], "auto-sync spoke about a note of the person's own: " + auto.notices.join(" | "));
	assert.equal(auto.vault.contentAt(`${E}/Character/Bob.md`), BOB);
	assert.equal(auto.vault.contentAt(`${E}/Character/Research.md`), RESEARCH);
	const byHand = await harnessSave({ notes, save: "Character/Research.md", server, manual: true });
	assert.deepEqual(byHand.calls, [], byHand.calls.join(" | "));
	assert.ok(byHand.notices.some((n) => /not a valid OnlyWorlds element note/.test(n)), byHand.notices.join(" | "));
});

test("Save still saves a genuine old span note, and refuses one whose id another note holds before any call", async () => {
	const saved = await harnessSave({
		notes: { "Character/Old.md": OLD(B, "Old", "New text.") },
		save: "Character/Old.md",
		server: { [B]: { name: "Old", description: "Server text." } },
		manual: false,
	});
	assert.deepEqual(saved.calls, [`get character ${B}`, `update character ${B}`], saved.calls.join(" | ") + " :: " + saved.notices.join(" | "));
	assert.equal(saved.sent[0]?.description, "New text.", JSON.stringify(saved.sent));
	const twin = await harnessSave({
		notes: { "Character/Old.md": OLD(A, "Old", "New text."), "Character/Bob.md": BOB },
		save: "Character/Old.md",
		server: { [A]: { name: "Bob", description: "Bob's real chapter." } },
		manual: false,
	});
	assert.deepEqual(twin.calls, [], twin.calls.join(" | "));
	assert.ok(twin.notices.some((n) => /holds the same id/.test(n)), twin.notices.join(" | "));
	assert.equal(twin.vault.contentAt(`${E}/Character/Bob.md`), BOB);
});

// --- 9 Update leaves an old span note to Migrate ---------------------------------------------------

test("★ Update world format leaves an old span note byte for byte and names Migrate; Migrate then converts it, and a 3.0 note in the same run is updated", async () => {
	const { app, vault } = makeApp();
	const old = `${E}/Character/Old.md`;
	const kai = `${E}/Character/Kai.md`;
	const kaiText = `---\nname: Kai\nid: ${B}\nphysicality: Tall.\n---\n\nA guard.\n`;
	await seedAll(vault, { [old]: OLD(A, "Old", "Original."), [kai]: kaiText });
	await update(app);
	assert.equal(vault.contentAt(old), OLD(A, "Old", "Original."), `Update rewrote an old span note:\n${vault.contentAt(old)}`);
	assert.ok(__notices.some((n) => /Old not updated/.test(n) && /Migrate world notes to frontmatter/.test(n)), __notices.join(" | "));
	const updated = vault.contentAt(kai) ?? "";
	assert.notEqual(updated, kaiText, "the 3.0 note was not updated");
	assert.match(updated, /### Physicality\n\nTall\./, updated);
	assert.match(updated, /### Description\n\nA guard\./, updated);
	const r = await migrate(app);
	assert.deepEqual(r?.converted, [old], JSON.stringify(r));
	const read = await readElement(app, app.vault.getAbstractFileByPath(old) as TFile, { fromBytes: true });
	assert.equal(read?.id, A, vault.contentAt(old));
	assert.equal(read?.name, "Old");
	assert.equal(read?.fields.description, "Original.");
});

// --- 10 Copy and Upload read each note once, from its bytes -----------------------------------------

const C = "019e0000-0000-7000-8000-0000000000c3";
const CHAPTER = `---\nid: ${A}\nname: Chapter\ntype: narrative\n---\n\n### Story\n\nThe only copy of my chapter.\n`;
const OLD_TWIN = `---\nid: ${A}\nname: Old\ntype: narrative\n---\n\n### Story\n\nAn obsolete draft.\n`;
const SPAN_CHAPTER = ["## Base", FIELD("Id", A), FIELD("Name", "Chapter"), FIELD("Story", "The only copy of my chapter."), ""].join("\n");
const MISFILED = `---\nid: ${B}\nname: Misfiled\ntype: location\n---\n\n### Description\n\nIn the wrong drawer.\n`;
const STALE_TYPE = { frontmatter: { id: A, name: "Chapter", type: "character" } };
const NO_ID = { frontmatter: { name: "Chapter" } };
const holds = (data: Record<string, unknown>, id: string) =>
	Object.entries(data).filter(([k, v]) => k !== "World" && Array.isArray(v) && (v as { id?: unknown }[]).some((e) => e.id === id)).map(([k]) => k);
const pick = (entries: Record<string, unknown>, path: string) => Object.entries(entries).find(([end]) => path.endsWith(end))?.[1];

/** Copy's data, with the metadata cache answering `entries` (by the end of a note's path) in place of what the notes hold. */
async function copyWithCache(notes: Record<string, string>, entries: Record<string, unknown>) {
	const { app, vault, cache } = makeApp();
	await seedAll(vault, notes);
	const c = cache as unknown as { getFileCache(f: { path: string }): unknown };
	const get = c.getFileCache.bind(c);
	c.getFileCache = (f: { path: string }) => pick(entries, f.path) ?? get(f);
	__notices.length = 0;
	const data = await copyData(app);
	return { data, vault, notices: [...__notices] };
}

/** An upload, with the metadata cache answering `entries` the same way. */
async function uploadWithCache(notes: Record<string, string>, entries: Record<string, unknown>) {
	const proto = (await import("./support/obsidian-mock")).MockMetadataCache.prototype as unknown as { getFileCache(f: { path: string }): unknown };
	const orig = proto.getFileCache;
	proto.getFileCache = function (this: unknown, f: { path: string }) {
		return pick(entries, f.path) ?? orig.call(this, f);
	};
	try {
		return await harnessUpload({ notes, changes: [] });
	} finally {
		proto.getFileCache = orig;
	}
}
const sentIds = (up: Awaited<ReturnType<typeof harnessUpload>>) => [...up.bulkSent.map((e) => String(e.id)), ...Object.keys(up.patches)];

test("★ Copy world takes a note's type from its bytes alone: a stale cache's type changes nothing, and a type property in a type folder is still the folder's", async () => {
	const notes = { [`${W}/Drafts/Chapter.md`]: CHAPTER, [`${E}/Character/Misfiled.md`]: MISFILED };
	const r = await copyWithCache(notes, { "Drafts/Chapter.md": STALE_TYPE });
	assert.deepEqual(holds(r.data, A), ["Narrative"], "Copy: " + JSON.stringify(r.data));
	assert.equal((r.data.Narrative[0] as { story?: unknown }).story, "The only copy of my chapter.");
	assert.ok(!r.notices.some((n) => /Chapter/.test(n)), r.notices.join(" | "));
	assert.deepEqual(holds(r.data, B), ["Character"], "Misfiled: " + JSON.stringify(r.data));
	assertUnchanged(r.vault, notes);
});

test("★ Copy world copies a note whose bytes hold an id and a type though the cache shows no id", async () => {
	const r = await copyWithCache({ [`${W}/Drafts/Chapter.md`]: CHAPTER }, { "Drafts/Chapter.md": NO_ID });
	assert.deepEqual(holds(r.data, A), ["Narrative"], "Copy: " + JSON.stringify(r.data));
});

test("★ Copy world refuses both notes that hold one id, whatever the cache says of either", async () => {
	const r = await copyWithCache({ [`${E}/Drafts/Chapter.md`]: CHAPTER, [`${E}/Archive/Old.md`]: OLD_TWIN }, { "Drafts/Chapter.md": STALE_TYPE });
	assert.deepEqual(holds(r.data, A), [], "Copy: " + JSON.stringify(r.data));
	assert.ok(r.notices.some((n) => /"Chapter" not copied: another note holds the same id/.test(n)), r.notices.join(" | "));
	assert.ok(r.notices.some((n) => /"Old" not copied: another note holds the same id/.test(n)), r.notices.join(" | "));
});

test("★ Copy world copies no element from an old span note outside the type folders, whatever the cache says; one in its type folder is copied", async () => {
	const r = await copyWithCache(
		{ [`${W}/Drafts/Chapter.md`]: SPAN_CHAPTER, [`${E}/Character/Real.md`]: OLD(C, "Real", "A real old note.") },
		{ "Drafts/Chapter.md": STALE_TYPE },
	);
	assert.deepEqual(holds(r.data, A), [], "Copy: " + JSON.stringify(r.data));
	assert.deepEqual(holds(r.data, C), ["Character"], "Real: " + JSON.stringify(r.data));
});

test("★ Upload world takes a note's type from its bytes alone: a stale cache's type changes nothing, and a type property in a type folder is still the folder's", async () => {
	const up = await uploadWithCache({ "Drafts/Chapter.md": CHAPTER, "Character/Misfiled.md": MISFILED }, { "Drafts/Chapter.md": STALE_TYPE });
	assert.equal(up.bulkTypes[A], "narrative", JSON.stringify(up.bulkTypes) + " " + up.notices.join(" | "));
	assert.equal(up.bulkSent.find((e) => e.id === A)?.story, "The only copy of my chapter.");
	assert.equal(up.bulkTypes[B], "character", JSON.stringify(up.bulkTypes));
});

test("★ Upload world sends a note whose bytes hold an id and a type though the cache shows no id", async () => {
	const up = await uploadWithCache({ "Drafts/Chapter.md": CHAPTER }, { "Drafts/Chapter.md": NO_ID });
	assert.equal(up.bulkTypes[A], "narrative", JSON.stringify(up.bulkTypes) + " " + up.notices.join(" | "));
});

test("★ Upload world sends neither of two notes that hold one id, whatever the cache says of either", async () => {
	const up = await uploadWithCache({ "Drafts/Chapter.md": CHAPTER, "Archive/Old.md": OLD_TWIN }, { "Drafts/Chapter.md": STALE_TYPE });
	assert.ok(!sentIds(up).includes(A), "Upload sent a note whose id another note holds: " + JSON.stringify(up.bulkSent));
	assert.ok(up.notices.some((n) => /another note holds the same id/.test(n)), up.notices.join(" | "));
});

test("★ Upload world sends no element from an old span note outside the type folders, whatever the cache says; one in its type folder is sent", async () => {
	const up = await uploadWithCache({ "Drafts/Chapter.md": SPAN_CHAPTER, "Character/Real.md": OLD(C, "Real", "A real old note.") }, { "Drafts/Chapter.md": STALE_TYPE });
	assert.ok(!sentIds(up).includes(A), "Upload sent an old span note outside the type folders: " + JSON.stringify(up.bulkTypes));
	assert.equal(up.bulkTypes[C], "character", JSON.stringify(up.bulkTypes));
});

// --- 11 Copy and Upload count duplicate ids before any other refusal --------------------------------

const D = "019e0000-0000-7000-8000-0000000000d4";
const FENCED = (id: string) => `---\nid: ${id}\nname: Fenced\n---\n\n### Description\n\nA.\n\n### Background\n\n~~~\ncode\n\n### Physicality\n\nTall.\n`;
const CLEAN = (id: string, name: string) => `---\nid: ${id}\nname: ${name}\n---\n\n### Description\n\nClean.\n`;

test("★ Copy world refuses both notes that hold one id when one of them is also refused for an open fence; a fenced note alone is refused for its fence", async () => {
	const r = await copyWithCache({ [`${E}/Character/Fenced.md`]: FENCED(A), [`${E}/Character/Twin.md`]: CLEAN(A, "Twin") }, {});
	assert.deepEqual(holds(r.data, A), [], "Copy: " + JSON.stringify(r.data));
	assert.ok(r.notices.some((n) => /"Fenced" not copied: another note holds the same id/.test(n)), r.notices.join(" | "));
	assert.ok(r.notices.some((n) => /"Twin" not copied: another note holds the same id/.test(n)), r.notices.join(" | "));
	const alone = await copyWithCache({ [`${E}/Character/Fenced.md`]: FENCED(D), [`${E}/Character/Clean.md`]: CLEAN(C, "Clean") }, {});
	assert.deepEqual(holds(alone.data, D), [], "Copy: " + JSON.stringify(alone.data));
	assert.ok(alone.notices.some((n) => /Fenced not copied: the code fence/.test(n)), alone.notices.join(" | "));
	assert.deepEqual(holds(alone.data, C), ["Character"], "Clean: " + JSON.stringify(alone.data));
});
