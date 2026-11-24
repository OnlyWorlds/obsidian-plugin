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
