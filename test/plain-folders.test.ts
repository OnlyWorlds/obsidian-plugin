/**
 * OW Obsidian #560: a type folder is `<Type>/`, no count (the Markdown
 * profile's address, Skeld h69 #10512). A fresh download writes plain folders;
 * every reader still reads a vault with the old `Location (2)` spelling; a
 * download into such a vault renames each counted folder once, through
 * Obsidian's renameFile so links are kept, and merges a counted folder into a
 * plain one beside it note by note. The Captain's rule binds every case: never
 * a deleted note, never an overwrite, never a renamed note (h69 #10556).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl, __notices, type MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { ValidateWorldCommand } from "../Commands/ValidateWorldCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { WorldService } from "../Scripts/WorldService";
import { readElement } from "../vault/element-file";
import { plainFoldersNotice, renameCountedCategoryFolders } from "../vault/plain-folders";
import { categoryFolderType, isCategoryFolderOf } from "../vault/category-folder";
import type { App as ObsidianApp, TFile } from "obsidian";

const WID = "019e5600-0000-7000-8000-0000000000ee";
const KEY = "ow_k_test560";
const W = "OnlyWorlds/Worlds/Barovia";
const E = `${W}/Elements`;
const CASTLE = "019e5600-0000-7000-8000-0000000000a1";
const KEEP = "019e5600-0000-7000-8000-0000000000a2";
const IREENA = "019e5600-0000-7000-8000-0000000000b1";
const OTHER_CASTLE = "019e5600-0000-7000-8000-0000000000a3";

const loc = (id: string, name: string) => `---\nid: ${id}\nname: ${name}\n---\n\n## Description\n\nA place called ${name}.\n`;
const IREENA_NOTE = `---\nid: ${IREENA}\nname: Ireena\nlocation: "[[Castle]]"\n---\n\n## Description\n\nLives in [[Castle]].\n`;
const upsert = (type: string, id: string, name: string, seq: number) => ({
	op: "upsert", type, id, change_seq: seq, updated_at: "x", element: { id, name },
});

type Mock = { app: ObsidianApp; vault: MockVault; renames: string[]; trashed: string[] };
/** A fresh mock vault whose renameFile really moves; the notices cleared. */
function vaultWithWorld(): Mock {
	__notices.length = 0;
	const { app, vault } = makeApp();
	const a = app as unknown as { realRenames: boolean; renames: string[]; trashed: string[] };
	a.realRenames = true;
	return { app, vault, renames: a.renames, trashed: a.trashed };
}
async function seedWorld(vault: MockVault): Promise<void> {
	await vault.seed(`${W}/World.md`, `# World Overview: Barovia\n\n- **Name:** Barovia\n- **API Key:** ${KEY}\n`);
}

function plugin() {
	return {
		settings: { syncCursors: {} as Record<string, unknown>, deletedOnServer: {} as Record<string, string[]> },
		saveSettings: async () => {},
	};
}
async function download(app: ObsidianApp, changes: unknown[], p = plugin()): Promise<string | null> {
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: "c9", has_more: false, head: 9, changes } };
		return { status: 404, json: {} };
	});
	return new DownloadWorldCommand(app, { version: "t" }, p as never).downloadWithKey(KEY, "1234");
}
/** Long enough for any debounced folder rename (the old counts waited 300 ms) to have run. */
const settle = () => new Promise((r) => setTimeout(r, 450));

/** The world's type folders, by name. */
function typeFolders(vault: MockVault): string[] {
	return [...vault.folders.keys()].filter((p) => p.startsWith(E + "/") && !p.slice(E.length + 1).includes("/"))
		.map((p) => p.slice(E.length + 1)).sort();
}
/** Every element note's bytes, by file name (names are unique in these vaults unless said). */
function notes(vault: MockVault): string[] {
	return [...vault.files.entries()].filter(([p]) => p.startsWith(E + "/") && p.endsWith(".md"))
		.map(([p, e]) => `${p.split("/").pop()}\n${e.content}`).sort();
}

// --- the one place that knows the old spelling -------------------------------

test("a type folder is its type in either spelling, and only its own type", () => {
	assert.equal(categoryFolderType("Location (2)"), "Location");
	assert.equal(categoryFolderType("Location"), "Location");
	assert.ok(isCategoryFolderOf("Location", "Location"));
	assert.ok(isCategoryFolderOf("Location (12)", "Location"));
	assert.ok(!isCategoryFolderOf("Location (old)", "Location"));
	assert.ok(!isCategoryFolderOf("Locations", "Location"));
	assert.ok(!isCategoryFolderOf("Map (3)", "Marker"));
});

// --- ruling 1: a fresh download writes <Type>/ -------------------------------

test("★ a fresh vault's download writes plain type folders, and nothing renames them after", async () => {
	const { app, vault } = vaultWithWorld();
	const got = await download(app, [upsert("location", CASTLE, "Castle", 1), upsert("location", KEEP, "Keep", 2), upsert("character", IREENA, "Ireena", 3)]);
	assert.equal(got, "Barovia");
	await settle();
	assert.deepEqual(typeFolders(vault), ["Character", "Location"]);
	assert.ok(vault.contentAt(`${E}/Location/Castle.md`));
	assert.ok(vault.contentAt(`${E}/Character/Ireena.md`));
});

test("creating an element writes into the plain folder and leaves its name alone", async () => {
	const { app, vault } = vaultWithWorld();
	await seedWorld(vault);
	const { CreateElementCommand } = await import("../Commands/CreateElementCommand");
	await new CreateElementCommand(app, {}, new WorldService(app)).execute("Location", "Krezk", "Barovia", false);
	await settle();
	assert.deepEqual(typeFolders(vault), ["Location"]);
	assert.ok(vault.contentAt(`${E}/Location/Krezk.md`));
});

// --- ruling 2 and 5: every reader takes both spellings, with no rename -------

async function countedVault(): Promise<Mock> {
	const m = vaultWithWorld();
	await seedWorld(m.vault);
	await m.vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	await m.vault.seed(`${E}/Location (2)/Keep.md`, loc(KEEP, "Keep"));
	await m.vault.seed(`${E}/Character (1)/Ireena.md`, IREENA_NOTE);
	return m;
}

test("★ a vault with counted folders is read by validate, the folder export and upload, with no rename", async () => {
	const { app, vault, renames } = await countedVault();
	const before = notes(vault);

	const validate = new ValidateWorldCommand(app, {} as never, new WorldService(app), false);
	await validate.execute("Barovia");
	assert.equal(validate.elementCount, 3);
	assert.equal(validate.errorCount, 0);

	const plan = await (new ExportFolderCommand(app as never) as unknown as {
		planFiles(w: string, id: string): Promise<{ files: { rel: string; content: string }[] }>;
	}).planFiles("Barovia", WID);
	const ireena = plan.files.find((f) => f.rel.includes("ireena"));
	assert.ok(ireena, plan.files.map((f) => f.rel).join(", "));
	assert.equal(JSON.parse(ireena.content).location, CASTLE);
	assert.equal(plan.files.filter((f) => /castle|keep/.test(f.rel)).length, 2);

	const data = await new ExportWorldCommand(app, {} as never, new WorldService(app)).collectWorldData("Barovia") as Record<string, unknown[]>;
	assert.equal(data.Location.length, 2);
	assert.equal(data.Character.length, 1);

	assert.deepEqual(renames, []);
	assert.deepEqual(notes(vault), before);
});

test("★ validate and upload read both spellings of one type at once", async () => {
	const { app, vault } = vaultWithWorld();
	await seedWorld(vault);
	await vault.seed(`${E}/Location/Castle.md`, loc(CASTLE, "Castle"));
	await vault.seed(`${E}/Location (2)/Keep.md`, loc(KEEP, "Keep"));
	const validate = new ValidateWorldCommand(app, {} as never, new WorldService(app), false);
	await validate.execute("Barovia");
	assert.equal(validate.elementCount, 2);
	const data = await new ExportWorldCommand(app, {} as never, new WorldService(app)).collectWorldData("Barovia") as Record<string, unknown[]>;
	assert.equal(data.Location.length, 2);
});

test("finding a type's folder prefers the plain spelling, and lists both", async () => {
	const { app, vault } = vaultWithWorld();
	await vault.seed(`${E}/Location (2)/Keep.md`, loc(KEEP, "Keep"));
	await vault.seed(`${E}/Location/Castle.md`, loc(CASTLE, "Castle"));
	await vault.seed(`${E}/Location (old)/Notes.md`, "mine\n");
	const ws = new WorldService(app);
	assert.equal((await ws.findCategoryFolderByBaseName("Barovia", "Location"))?.name, "Location");
	const all = (ws as unknown as { findCategoryFolders(w: string, t: string): Promise<{ name: string }[]> }).findCategoryFolders;
	assert.equal(typeof all, "function");
	assert.deepEqual((await all.call(ws, "Barovia", "Location")).map((f) => f.name), ["Location", "Location (2)"]);
});

// --- ruling 3: the one-time rename on Download -------------------------------

test("★ a download into a counted vault renames each folder once, keeps every note's bytes, and says so in one notice", async () => {
	const { app, vault, renames } = await countedVault();
	const before = notes(vault);

	await download(app, []);
	await settle();
	assert.deepEqual(typeFolders(vault), ["Character", "Location"]);
	assert.deepEqual(renames.sort(), [`${E}/Character (1) -> ${E}/Character`, `${E}/Location (2) -> ${E}/Location`]);
	assert.deepEqual(notes(vault), before, "no note lost, added, renamed or changed");
	const said = __notices.filter((n) => /renamed without the count/.test(n));
	assert.equal(said.length, 1, __notices.join(" / "));
	assert.match(said[0], /^2 type folders renamed without the count: Character \(1\) and Location \(2\) are now Character and Location\. Links by note name still work; links written with a folder path follow your Obsidian setting for updating links\./);

	// The second download: renamed 0, no notice.
	__notices.length = 0;
	await download(app, []);
	await settle();
	assert.equal(renames.length, 2);
	assert.equal(__notices.filter((n) => /renamed|Not moved/.test(n)).length, 0, __notices.join(" / "));
	assert.deepEqual(notes(vault), before);
});

test("★ after the rename a note's link still resolves, in Obsidian and in the plugin's reader", async () => {
	const { app, vault } = await countedVault();
	await download(app, []);
	const ireena = vault.getAbstractFileByPath(`${E}/Character/Ireena.md`) as unknown as TFile;
	assert.ok(ireena);
	assert.equal(app.metadataCache.getFirstLinkpathDest("Castle", ireena.path)?.path, `${E}/Location/Castle.md`);
	const read = await readElement(app, ireena);
	assert.equal(read?.fields.location, CASTLE);
});

test("★ the download into a counted vault writes its new notes into the plain folders, and updates the old ones in place", async () => {
	const { app, vault } = await countedVault();
	await download(app, [upsert("location", CASTLE, "Castle", 1), upsert("location", OTHER_CASTLE, "Vallaki", 2)]);
	await settle();
	assert.deepEqual(typeFolders(vault), ["Character", "Location"]);
	assert.ok(vault.contentAt(`${E}/Location/Vallaki.md`));
	assert.match(vault.contentAt(`${E}/Location/Castle.md`) ?? "", new RegExp(`id: ${CASTLE}`));
	assert.equal(notes(vault).length, 4);
});

// --- ruling 4: the Bases file -------------------------------------------------

test("★ the Bases file the download writes names the plain folders", async () => {
	const { app, vault } = await countedVault();
	await download(app, []);
	const base = vault.contentAt(`${W}/Barovia.base`) ?? "";
	assert.ok(base.includes(`file.inFolder("${E}/Location")`), base.slice(0, 400));
	assert.ok(base.includes(`file.inFolder("${E}/Character")`));
	assert.deepEqual(typeFolders(vault), ["Character", "Location"]);
});

// --- ruling 3: both spellings, and a taken name -------------------------------

test("★ both spellings of one type: the counted folder's notes move into the plain one, then the empty folder goes", async () => {
	const { app, vault, renames, trashed } = vaultWithWorld();
	await seedWorld(vault);
	await vault.seed(`${E}/Location/Keep.md`, loc(KEEP, "Keep"));
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	await vault.seed(`${E}/Location (2)/Castle map.png`, "PNG");
	const before = notes(vault);

	await download(app, []);
	assert.deepEqual(typeFolders(vault), ["Location"]);
	assert.deepEqual(notes(vault), before);
	assert.equal(vault.contentAt(`${E}/Location/Castle map.png`), "PNG");
	assert.deepEqual(renames.sort(), [`${E}/Location (2)/Castle map.png -> ${E}/Location/Castle map.png`, `${E}/Location (2)/Castle.md -> ${E}/Location/Castle.md`]);
	assert.deepEqual(trashed, [`${E}/Location (2)`], "only the empty folder goes, to the trash");
	assert.deepEqual(vault.deletes, []);
	assert.match(__notices.join("\n"), /1 type folder renamed without the count: Location \(2\) is now Location\./);
});

test("★ a name taken in the plain folder: nothing of that folder moves, nothing is deleted, the notice names folder and note", async () => {
	const { app, vault, renames, trashed } = vaultWithWorld();
	await seedWorld(vault);
	await vault.seed(`${E}/Location/Castle.md`, loc(OTHER_CASTLE, "Castle"));
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	await vault.seed(`${E}/Location (2)/Keep.md`, loc(KEEP, "Keep"));
	await vault.seed(`${E}/Character (1)/Ireena.md`, IREENA_NOTE);
	const before = notes(vault);
	assert.equal(before.length, 4);

	await download(app, []);
	assert.deepEqual(notes(vault), before, "the same four notes, byte for byte");
	assert.deepEqual(typeFolders(vault), ["Character", "Location", "Location (2)"]);
	assert.equal(vault.contentAt(`${E}/Location (2)/Castle.md`), loc(CASTLE, "Castle"));
	assert.equal(vault.contentAt(`${E}/Location (2)/Keep.md`), loc(KEEP, "Keep"));
	assert.deepEqual(renames, [`${E}/Character (1) -> ${E}/Character`]);
	assert.deepEqual(vault.deletes, []);
	assert.deepEqual(trashed, []);
	const said = __notices.join("\n");
	assert.match(said, /Not moved: Location \(2\), because Location already holds Castle\.md\. Nothing was deleted/);
	assert.match(said, /1 type folder renamed without the count/);
});

test("★ with a folder stuck, the download updates the note where it is and writes no second note for it", async () => {
	const { app, vault } = vaultWithWorld();
	await seedWorld(vault);
	await vault.seed(`${E}/Location/Castle.md`, loc(OTHER_CASTLE, "Castle"));
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	await download(app, [upsert("location", CASTLE, "Castle", 1), upsert("location", OTHER_CASTLE, "Castle", 2)]);
	await settle();
	assert.equal(notes(vault).length, 2, notes(vault).map((n) => n.split("\n")[0]).join(", "));
	assert.match(vault.contentAt(`${E}/Location (2)/Castle.md`) ?? "", new RegExp(`id: ${CASTLE}`));
	assert.match(vault.contentAt(`${E}/Location/Castle.md`) ?? "", new RegExp(`id: ${OTHER_CASTLE}`));
});

test("the pass leaves a folder that only looks counted, and one of no type, alone", async () => {
	const { app, vault, renames } = vaultWithWorld();
	await vault.seed(`${E}/Location (old)/a.md`, "mine\n");
	await vault.seed(`${E}/Drafts (2)/b.md`, "mine\n");
	const r = await renameCountedCategoryFolders(app, "Barovia");
	assert.deepEqual(r, { renamed: [], stuck: [], kept: [] });
	assert.deepEqual(renames, []);
});

test("a file in the way of the plain name: the counted folder stays, said, never replaced", async () => {
	const { app, vault, renames } = vaultWithWorld();
	await vault.seed(`${E}/Location`, "a file someone named Location\n");
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	const r = await renameCountedCategoryFolders(app, "Barovia");
	assert.deepEqual(r.renamed, []);
	assert.equal(r.stuck.length, 1);
	assert.deepEqual(renames, []);
	assert.equal(vault.contentAt(`${E}/Location`), "a file someone named Location\n");
});

// --- Amendment A (Kael's cold read of ada0e81) -------------------------------

test("★ an emptied counted folder that still holds a hidden file on disk stays where it is (A1)", async () => {
	const { app, vault, trashed } = vaultWithWorld();
	await vault.seed(`${E}/Location/Keep.md`, loc(KEEP, "Keep"));
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	await vault.adapter.write(`${E}/Location (2)/.DS_Store`, "finder");
	const r = await renameCountedCategoryFolders(app, "Barovia");
	assert.ok(vault.contentAt(`${E}/Location/Castle.md`));
	assert.deepEqual(trashed, [], "the disk shows a file in it: never trashed");
	assert.ok(vault.folders.has(`${E}/Location (2)`));
	assert.equal(vault.dotfiles.get(`${E}/Location (2)/.DS_Store`), "finder");
});

test("an emptied counted folder the disk shows empty goes to the trash (A1)", async () => {
	const { app, vault, trashed } = vaultWithWorld();
	await vault.seed(`${E}/Location/Keep.md`, loc(KEEP, "Keep"));
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	await renameCountedCategoryFolders(app, "Barovia");
	assert.deepEqual(trashed, [`${E}/Location (2)`]);
});

test("★ Obsidian refusing a move part way: the entry says error and how many moved, the notice says so, nothing is lost (A2)", async () => {
	const { app, vault, renames, trashed } = vaultWithWorld();
	await vault.seed(`${E}/Location/Keep.md`, loc(KEEP, "Keep"));
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	await vault.seed(`${E}/Location (2)/Vallaki.md`, loc(OTHER_CASTLE, "Vallaki"));
	const fm = (app as unknown as { fileManager: { renameFile(f: { path: string }, to: string): Promise<void> } }).fileManager;
	const real = fm.renameFile;
	fm.renameFile = async (f, to) => {
		if (f.path.endsWith("/Vallaki.md")) throw new Error("Obsidian said no");
		return real(f, to);
	};
	const before = notes(vault);
	const r = await renameCountedCategoryFolders(app, "Barovia");
	assert.deepEqual(r.renamed, []);
	assert.equal(r.stuck.length, 1);
	const s = r.stuck[0] as unknown as { why: string; moved: number; note: string };
	assert.equal(s.why, "error");
	assert.equal(s.moved, 1);
	assert.equal(s.note, "Vallaki.md");
	assert.deepEqual(notes(vault), before);
	assert.deepEqual(trashed, []);
	assert.equal(renames.length, 1);
	assert.equal(
		plainFoldersNotice(r),
		"1 of 2 notes moved from Location (2) into Location, then Obsidian refused Vallaki.md. Nothing was deleted; download again after moving the rest by hand."
	);
});

test("a clash keeps its wording and is marked as one (A2)", async () => {
	const { app, vault } = vaultWithWorld();
	await vault.seed(`${E}/Location/Castle.md`, loc(OTHER_CASTLE, "Castle"));
	await vault.seed(`${E}/Location (2)/Castle.md`, loc(CASTLE, "Castle"));
	const r = await renameCountedCategoryFolders(app, "Barovia");
	const s = r.stuck[0] as unknown as { why: string; moved: number };
	assert.equal(s.why, "clash");
	assert.equal(s.moved, 0);
	assert.match(plainFoldersNotice(r) ?? "", /^Not moved: Location \(2\), because Location already holds Castle\.md\. Nothing was deleted/);
});

// --- Amendment B (Seethe's real-vault walk, Kael's read) ----------------------

test("★ a counted folder kept for a hidden file is not counted as renamed, is said once, and a later pass skips it in silence (B2)", async () => {
	const { app, vault, renames, trashed } = vaultWithWorld();
	await vault.seed(`${E}/Species/Human.md`, loc(KEEP, "Human"));
	await vault.seed(`${E}/Species (1)/Elf.md`, loc(CASTLE, "Elf"));
	await vault.adapter.write(`${E}/Species (1)/.DS_Store`, "finder");
	const r = await renameCountedCategoryFolders(app, "Barovia");
	assert.deepEqual(r.renamed, []);
	assert.deepEqual(r.stuck, []);
	assert.deepEqual((r as unknown as { kept: unknown }).kept, [{ folder: "Species (1)", file: ".DS_Store" }]);
	assert.ok(vault.contentAt(`${E}/Species/Elf.md`));
	assert.deepEqual(trashed, []);
	assert.equal(plainFoldersNotice(r), "Species (1)'s notes moved into Species; the folder stays because it holds .DS_Store, which Obsidian does not show.");

	const again = await renameCountedCategoryFolders(app, "Barovia");
	assert.deepEqual(again, { renamed: [], stuck: [], kept: [] });
	assert.equal(plainFoldersNotice(again), null);
	assert.equal(renames.length, 1);
	assert.equal(vault.dotfiles.get(`${E}/Species (1)/.DS_Store`), "finder");
});

test("★ the renamed line names the folders: all of them up to four (B3)", async () => {
	const { app, vault } = vaultWithWorld();
	for (const f of ["Character (3)", "Location (2)", "Species (1)"]) await vault.seed(`${E}/${f}/a.md`, "x\n");
	const notice = plainFoldersNotice(await renameCountedCategoryFolders(app, "Barovia")) ?? "";
	assert.match(notice, /^3 type folders renamed without the count: Character \(3\), Location \(2\) and Species \(1\) are now Character, Location and Species\. /);
});

test("the renamed line past four names the first three and how many more (B3)", async () => {
	const { app, vault } = vaultWithWorld();
	for (const f of ["Ability (1)", "Character (3)", "Location (2)", "Species (1)", "Zone (4)"]) await vault.seed(`${E}/${f}/a.md`, "x\n");
	const notice = plainFoldersNotice(await renameCountedCategoryFolders(app, "Barovia")) ?? "";
	assert.match(notice, /^5 type folders renamed without the count: Ability \(1\), Character \(3\), Location \(2\) and 2 more are now Ability, Character, Location and 2 more\. /);
});

const START = "Renaming your type folders to drop the count. Obsidian may ask whether to update links; Always update or Just once answers it for the rest.";

test("★ before the pass renames anything, one notice says Obsidian may ask about links; none when nothing is counted (B1)", async () => {
	const counted = await countedVault();
	await download(counted.app, []);
	const i = __notices.indexOf(START);
	assert.ok(i >= 0, __notices.join(" / "));
	assert.ok(i < __notices.findIndex((n) => /renamed without the count/.test(n)));
	assert.equal(__notices.filter((n) => n === START).length, 1);

	__notices.length = 0;
	await download(counted.app, []);
	assert.equal(__notices.filter((n) => n === START).length, 0, "the second download finds nothing counted");
});
