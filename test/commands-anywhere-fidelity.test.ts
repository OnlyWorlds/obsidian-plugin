/**
 * The last of the cold reads' reproductions on the commands that read notes
 * anywhere: an old note's field value that holds inline code is read whole;
 * a front matter `id` of any value keeps a note from being taken for an old
 * one; Import names a link target from the id on the disk; Copy writes over
 * only output of its own shape; Update never keeps one of two prose copies;
 * indentation that mixes spaces and tabs is code; and Copy's validator reads
 * ids as its collector does. Each runs through the real command and an
 * in-memory vault.
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
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { WorldService } from "../Scripts/WorldService";

const A = "019d0000-0000-7000-8000-0000000000a1";
const B = "019d0000-0000-7000-8000-0000000000b1";
const C = "019d0000-0000-7000-8000-0000000000c1";

const SPAN = (id: string, name: string, text: string, indent = "") =>
	`${indent}- <span class="text-field" data-tooltip="Text">Id</span>: ${id}\n` +
	`${indent}- <span class="text-field" data-tooltip="Text">Name</span>: ${name}\n` +
	`${indent}- <span class="text-field" data-tooltip="Text">Description</span>: ${text}\n`;

type MigrationReport = { converted: string[]; failed: { path: string; reason: string }[] };
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

// --- 1 an old note's field value is read whole ---------------------------------------

const MOON = "Speak `Moon Sword` aloud.";

test("★ an old note's value holding inline code migrates, copies and uploads whole", async () => {
	const { app, vault } = makeApp();
	await seedAll(vault, { [`${E}/Character/Bob.md`]: SPAN(A, "Bob", MOON) });
	const data = await copyData(app);
	assert.equal(data.Character[0]?.description, MOON, "Copy: " + JSON.stringify(data.Character));
	const r = await migrate(app);
	assert.deepEqual(r?.converted, [`${E}/Character/Bob.md`], JSON.stringify(r));
	assert.ok((vault.contentAt(`${E}/Character/Bob.md`) ?? "").includes(MOON), "Migrate: " + vault.contentAt(`${E}/Character/Bob.md`));
	const up = await harnessUpload({ notes: { "Character/Bob.md": SPAN(A, "Bob", MOON) }, changes: [] });
	assert.equal(up.bulkSent[0]?.description, MOON, "Upload: " + JSON.stringify(up.bulkSent));
});

// --- 2 an id key of any value ---------------------------------------------------------------

test("★ Migrate never takes a note whose front matter holds an id key of any value for an old note", async () => {
	const { app, vault } = makeApp();
	const notes: Record<string, string> = {
		[`${E}/Character/Diary.md`]: `---\nid: false\ntags: [draft]\n---\n\nMy chapter.\n\n${SPAN(A, "Example", "Example only.")}`,
		[`${E}/Character/Listed.md`]: `---\nid: [1, 2]\n---\n\nMine.\n\n${SPAN(B, "Example", "Example only.")}`,
		[`${E}/Character/Empty.md`]: `---\nid:\n---\n\nMine.\n\n${SPAN(C, "Example", "Example only.")}`,
	};
	await seedAll(vault, notes);
	const r = await migrate(app);
	assertUnchanged(vault, notes);
	assert.deepEqual(r?.converted ?? [], [], JSON.stringify(r));
});

// --- 3 Import names a link target from the id on the disk ----------------------------------

test("★ Import names a link target from the id a note holds on the disk, never from a stale cache", async () => {
	const { app, vault, cache } = makeApp();
	const oldTown = `${E}/Location/OldTown.md`;
	await seedAll(vault, { [oldTown]: `---\nid: ${A}\nname: OldTown\n---\n\nThe town.\n` });
	const c = cache as unknown as { getFileCache(f: { path: string }): unknown };
	const get = c.getFileCache.bind(c);
	c.getFileCache = (f: { path: string }) => (f.path === oldTown ? { frontmatter: { id: B, name: "OldTown" } } : get(f));
	const dir = "import/w";
	await vault.seed(`${dir}/world.json`, JSON.stringify({ id: "0199aaaa-0000-7000-8000-0000000000f0", name: "W" }));
	await vault.seed(`${dir}/elements/location/b.json`, JSON.stringify({ type: "location", id: B, name: "Newtown" }));
	await vault.seed(`${dir}/elements/character/c.json`, JSON.stringify({ type: "character", id: C, name: "Cara", location: B }));
	__modals.length = 0;
	await (new ImportFolderCommand(app) as unknown as { importFolder(dir: string): Promise<void> }).importFolder(dir);
	const cara = vault.contentAt(`${E}/Character/Cara.md`) ?? "";
	assert.doesNotMatch(cara, /\[\[OldTown\]\]/, "a link to B names the note that holds A: " + cara);
	assert.equal(vault.contentAt(oldTown), `---\nid: ${A}\nname: OldTown\n---\n\nThe town.\n`);
});

// --- 4 Copy's own output, by its shape -------------------------------------------------------

function withClipboard(): void {
	Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true });
}

test("★ Copy world never writes over a note that is JSON with a type's name as a key but not its own output", async () => {
	withClipboard();
	const { app, vault } = makeApp();
	const chapter = '{"Character":"The only copy of my chapter."}';
	await seedAll(vault, { [`${W}/World Data File.md`]: chapter });
	__notices.length = 0;
	await new CopyWorldCommand(app, {} as never, new WorldService(app)).copyWorldData("W");
	assert.equal(vault.contentAt(`${W}/World Data File.md`), chapter, "a person's note was overwritten");
	assert.ok(__notices.some((n) => /World Data File/.test(n) && /not overwritten/.test(n)), __notices.join(" | "));
});

// --- 5 two prose copies of one field -----------------------------------------------------------

async function update(app: App): Promise<void> {
	__notices.length = 0;
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<unknown>; apply(p: unknown): Promise<void> };
	await cmd.apply(await cmd.buildPlan("W"));
}

test("★ Update world format refuses a note whose description is both a property and the note's body, and names it", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${W}/Drafts/Zel.md`]: `---\nid: ${A}\ntype: character\nname: Zel\ndescription: "Old summary"\n---\n\nMy irreplaceable chapter.\n` };
	await seedAll(vault, notes);
	await update(app);
	assertUnchanged(vault, notes);
	assert.ok(__notices.some((n) => /Zel not updated/.test(n)), __notices.join(" | "));
});

test("★ Update world format refuses a note whose text field is both a property and a body section, and names it", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${E}/Character/Kai.md`]: `---\nname: Kai\nid: ${B}\nphysicality: "Short"\n---\n\n### Description\n\nA guard.\n\n### Physicality\n\nTall.\n` };
	await seedAll(vault, notes);
	await update(app);
	assertUnchanged(vault, notes);
	assert.ok(__notices.some((n) => /Kai not updated/.test(n)), __notices.join(" | "));
});

// --- 6 indentation that mixes spaces and tabs ----------------------------------------------------

test("★ Migrate reads a line indented by a space and a tab as code, never as an old note's field", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${E}/Character/Example.md`]: `---\ntags: [draft]\n---\n\nMy prose.\n\n${SPAN(A, "Example", "Example only.", " \t")}` };
	await seedAll(vault, notes);
	const r = await migrate(app);
	assertUnchanged(vault, notes);
	assert.deepEqual(r?.converted ?? [], [], JSON.stringify(r));
});

// --- 7 Copy's validator reads ids as its collector does --------------------------------------------

test("★ Copy world's validation reads an id written with a comment or under a quoted key, as the copy does", async () => {
	const { app, vault } = makeApp();
	await seedAll(vault, {
		[`${E}/Character/Bob.md`]: `---\nname: Bob\nid: ${A} # Bob's identity\n---\n\n### Description\n\nBob.\n`,
		[`${E}/Character/Cara.md`]: `---\nname: Cara\n"id": ${B}\n---\n\n### Description\n\nCara.\n`,
	});
	__modals.length = 0;
	await new CopyWorldCommand(app, {} as never, new WorldService(app)).processWorldCopy("W");
	const modal = __modals.find((m) => m.constructor.name === "ValidateCopyResultModal") as unknown as { errorCount: number; elementCount: number; errors: unknown };
	assert.equal(modal.errorCount, 0, JSON.stringify(modal.errors));
	assert.equal(modal.elementCount, 2);
});
