/**
 * Copy world, Migrate, Import folder and Update world format read a world's
 * element notes wherever they sit (the Markdown profile, sentences 1 to 3), as
 * the pull, Save, Upload, the folder export and Validate do since notes
 * anywhere: the folder decides the type, else the note's `type` property, and a
 * note with no id is the person's own. Each runs on the four-notes vault
 * (test/support/four-notes.ts) through the real command and an in-memory vault.
 *
 * Migrate and Update world format rewrite notes: each writes a note with one
 * vault.modify, never processFrontMatter (THE WRITE RULE).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __modals, type MockVault } from "./support/obsidian-mock";
import { W, E, IREENA, AKRAGAS, OUTSIDE, MISFILED, KOLYAN, PATHS, note, seedFourNotes } from "./support/four-notes";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { MigrateWorldCommand } from "../Commands/MigrateWorldCommand";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { WorldService } from "../Scripts/WorldService";
import { parseRawFrontmatter, readElement } from "../vault/element-file";

/**
 * Every vault.modify by path, and every processFrontMatter call. The mock has no
 * processFrontMatter; this one records the call and applies it as Obsidian would,
 * so a command that still uses it runs and the test can say it did.
 */
function watchWrites(app: App, vault: MockVault): { modifies: Map<string, number>; fmCalls: string[] } {
	const modifies = new Map<string, number>();
	const fmCalls: string[] = [];
	const v = app.vault as unknown as { modify(f: TFile, c: string): Promise<void> };
	const modify = v.modify.bind(v);
	v.modify = async (f: TFile, c: string) => {
		modifies.set(f.path, (modifies.get(f.path) ?? 0) + 1);
		return modify(f, c);
	};
	(app as unknown as { fileManager: Record<string, unknown> }).fileManager.processFrontMatter = async (
		f: TFile,
		fn: (fm: Record<string, unknown>) => void
	) => {
		fmCalls.push(f.path);
		const content = vault.contentAt(f.path) ?? "";
		const fm = parseRawFrontmatter(content) ?? {};
		fn(fm);
		const lines = Object.entries(fm).map(([k, val]) => `${k}: ${typeof val === "object" ? JSON.stringify(val) : val ?? ""}`);
		const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
		await modify(f, `---\n${lines.join("\n")}\n---\n${body}`);
	};
	return { modifies, fmCalls };
}

// --- Copy world ---------------------------------------------------------------

test("★ Copy world copies an element note wherever it sits, of the type its folder or its type property decides, and never a note with no id", async () => {
	const { app, vault } = makeApp();
	await seedFourNotes(vault);
	__modals.length = 0;
	const data = (await new CopyWorldCommand(app, {} as never, new WorldService(app)).collectWorldData(W)) as Record<string, Record<string, unknown>[]>;
	const ids = (type: string) => (data[type] ?? []).map((e) => e.id).sort();
	assert.deepEqual(ids("Location"), [AKRAGAS], "Location: " + JSON.stringify(data.Location));
	assert.deepEqual(ids("Character"), [IREENA, MISFILED, KOLYAN].sort(), "Character: " + JSON.stringify(data.Character));
	const all = Object.entries(data).filter(([k]) => k !== "World").flatMap(([, v]) => v);
	assert.equal(all.length, 4, "a note with no id or outside the world was copied: " + JSON.stringify(all.map((e) => e.name)));
	assert.ok(!all.some((e) => e.id === OUTSIDE), "a note outside the world was copied");
	const akragas = data.Location.find((e) => e.id === AKRAGAS)!;
	assert.equal(akragas.description, "A hill town.");
});

// --- Migrate ------------------------------------------------------------------

const SPAN = (id: string, name: string, text: string) =>
	`## Base\n- <span class="text-field" data-tooltip="Text">Id</span>: ${id}\n` +
	`- <span class="text-field" data-tooltip="Text">Name</span>: ${name}\n` +
	`- <span class="text-field" data-tooltip="Text">Description</span>: ${text}\n`;

const GELA = "019b0000-0000-7000-8000-0000000000b1";
const LORE = "019b0000-0000-7000-8000-0000000000b2";
const SELINUS = "019b0000-0000-7000-8000-0000000000b3";
const DRAFT = "019b0000-0000-7000-8000-0000000000b4";

async function migrate(app: App): Promise<{ converted: string[]; skipped: string[]; failed: { path: string; reason: string }[] }> {
	__modals.length = 0;
	await (new MigrateWorldCommand(app) as unknown as { migrateWorld(w: string): Promise<void> }).migrateWorld("W");
	return (__modals.at(-1) as unknown as { result: { converted: string[]; skipped: string[]; failed: { path: string; reason: string }[] } }).result;
}

test("★ Migrate converts an old span note wherever the profile reads it as an element, keeps its type property, and leaves a note of no type alone", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	// the control: a span note in its type folder
	await vault.seed(`${E}/Location/Gela.md`, SPAN(GELA, "Gela", "A town."));
	// in a type-named folder outside Elements/: the folder decides
	await vault.seed(`${W}/Lore/Location/Lore town.md`, SPAN(LORE, "Lore town", "From the lore."));
	// moved into a folder that is no type's, a `type` added in Properties
	await vault.seed(`${E}/Places/Selinus.md`, `---\ntype: location\n---\n${SPAN(SELINUS, "Selinus", "A temple town.")}`);
	// moved into a folder that is no type's with no `type`: the person's own now
	const draft = SPAN(DRAFT, "Draft", "Mine.");
	await vault.seed(`${E}/Places/Draft.md`, draft);
	const w = watchWrites(app, vault);

	const r = await migrate(app);
	assert.deepEqual(r.failed, [], JSON.stringify(r.failed));
	assert.deepEqual(r.converted.sort(), [`${E}/Location/Gela.md`, `${E}/Places/Selinus.md`, `${W}/Lore/Location/Lore town.md`].sort(), JSON.stringify(r));
	assert.equal(vault.contentAt(`${E}/Places/Draft.md`), draft, "a note of no type was rewritten");
	for (const [path, id] of [[`${W}/Lore/Location/Lore town.md`, LORE], [`${E}/Places/Selinus.md`, SELINUS]]) {
		const el = await readElement(app, app.vault.getAbstractFileByPath(path) as TFile);
		assert.equal(el?.id, id, path + "\n" + vault.contentAt(path));
		assert.equal(el?.category, "location", path + "\n" + vault.contentAt(path));
	}
	assert.match(vault.contentAt(`${E}/Places/Selinus.md`) ?? "", /^type: location$/m, "the type property that makes it an element was dropped");
	// THE WRITE RULE: one write per note, never processFrontMatter
	assert.deepEqual(w.fmCalls, [], "processFrontMatter on an element note");
	for (const p of r.converted) assert.equal(w.modifies.get(p), 1, `${p} written ${w.modifies.get(p)} times`);
});

// --- Import folder --------------------------------------------------------------

test("★ Import folder sees an element note the person moved out of its type folder: it is skipped, never written over, and a link to it names its note", async () => {
	const { app, vault } = makeApp();
	await seedFourNotes(vault);
	// Kolyan's note moved and renamed by the person
	const moved = note({ name: "Kolyan", id: KOLYAN, type: "character" }, "### Description\n\nMine, moved.\n");
	await vault.seed(`${W}/Cast/Kolyan Indirovich.md`, moved);
	await app.vault.delete(app.vault.getAbstractFileByPath(PATHS.kolyan)!);
	const akragasBefore = vault.contentAt(PATHS.akragas);
	const dir = "import/w";
	await vault.seed(`${dir}/world.json`, JSON.stringify({ id: "0199aaaa-0000-7000-8000-0000000000f0", name: "W" }));
	const NEW = "019b0000-0000-7000-8000-0000000000c1";
	await vault.seed(`${dir}/elements/character/kolyan.json`, JSON.stringify({ id: KOLYAN, type: "character", name: "Kolyan", description: "From the folder." }));
	await vault.seed(`${dir}/elements/location/akragas.json`, JSON.stringify({ id: AKRAGAS, type: "location", name: "Akragas", description: "From the folder." }));
	await vault.seed(`${dir}/elements/character/doru.json`, JSON.stringify({ id: NEW, type: "character", name: "Doru", friends: [KOLYAN] }));
	__modals.length = 0;
	await (new ImportFolderCommand(app) as unknown as { importFolder(dir: string): Promise<void> }).importFolder(dir);

	assert.equal(vault.contentAt(`${W}/Cast/Kolyan Indirovich.md`), moved, "the moved note was written over");
	assert.equal(vault.contentAt(PATHS.akragas), akragasBefore, "the typed note in a folder of no type was written over");
	assert.equal(vault.contentAt(`${E}/Character/Kolyan.md`), undefined, "a second note was made for an element the world holds");
	assert.equal(vault.contentAt(`${E}/Location/Akragas.md`), undefined, "a second note was made for an element the world holds");
	const report = __modals.find((m) => m.constructor.name === "ImportReportModal") as unknown as { result: { created: string[]; skipped: string[] } };
	assert.deepEqual(report.result.skipped.sort(), [AKRAGAS, KOLYAN].sort(), JSON.stringify(report.result));
	assert.deepEqual(report.result.created, [NEW]);
	assert.match(vault.contentAt(`${E}/Character/Doru.md`) ?? "", /\[\[Kolyan Indirovich\]\]/, vault.contentAt(`${E}/Character/Doru.md`));
});

// --- Update world format --------------------------------------------------------

type Plan = { scanned: number; notes: { path: string; category: string; needsReview: boolean }[] };
function updater(app: App) {
	return new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<Plan>; apply(p: Plan): Promise<void> };
}

/** A 3.0/3.1 note: text in the body with no section, nothing scaffolded. */
const legacyBody = (text: string) => `${text}\n`;

test("★ Update world format plans every element note wherever it sits, of the type its folder or type property decides, and never a note with no id", async () => {
	const { app, vault } = makeApp();
	await seedFourNotes(vault, legacyBody);
	const plan = await updater(app).buildPlan("W");
	const byPath = Object.fromEntries(plan.notes.map((n) => [n.path, n.category]));
	assert.deepEqual(byPath, {
		[PATHS.ireena]: "character",
		[PATHS.akragas]: "location",
		[PATHS.misfiled]: "character",
		[PATHS.kolyan]: "character",
	}, JSON.stringify(plan.notes));
	assert.equal(plan.scanned, 4);
});

test("★ Update world format rewrites a note outside the type folders in one write: its sections, its type's properties, its type property kept", async () => {
	const { app, vault } = makeApp();
	await seedFourNotes(vault, legacyBody);
	const w = watchWrites(app, vault);
	const cmd = updater(app);
	await cmd.apply(await cmd.buildPlan("W"));
	assert.deepEqual(w.fmCalls, [], "processFrontMatter on an element note");
	for (const p of [PATHS.ireena, PATHS.akragas, PATHS.misfiled, PATHS.kolyan]) assert.equal(w.modifies.get(p), 1, `${p} written ${w.modifies.get(p)} times`);
	const text = vault.contentAt(PATHS.akragas) ?? "";
	assert.match(text, /^type: location$/m, text);
	assert.match(text, /^### Description\n\nA hill town\.$/m, text);
	assert.match(text, /^parent_location:/m, "the type's properties were not added: " + text);
	const el = await readElement(app, app.vault.getAbstractFileByPath(PATHS.akragas) as TFile);
	assert.equal(el?.category, "location");
	assert.equal(el?.fields.description, "A hill town.");
	// a text field the 3.0 note held in its front matter moves to the body, and leaves the front matter
	await vault.seed(`${W}/Cast/Strahd.md`, note({ name: "Strahd", id: "019b0000-0000-7000-8000-0000000000d1", type: "character", physicality: "Tall." }, legacyBody("A count.")));
	await cmd.apply(await cmd.buildPlan("W"));
	const strahd = vault.contentAt(`${W}/Cast/Strahd.md`) ?? "";
	assert.doesNotMatch(strahd.split("\n---")[0], /physicality/, strahd);
	assert.match(strahd, /^### Physicality\n\nTall\.$/m, strahd);
	assert.equal(vault.contentAt(PATHS.npcOne), note({ name: "Npc one", type: "npc" }, legacyBody("No id, in Character/.")), "a note with no id was rewritten");
});
