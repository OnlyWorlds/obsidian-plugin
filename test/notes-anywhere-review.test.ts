/**
 * What the cold read of the notes-anywhere change found, each as a test that is red without its fix:
 * a person's own note must never make anything fail or be written over; the pull and Save must agree on
 * what an element note is; a group entry must never break a note's front matter.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { AutoSyncEngine } from "../sync/auto-sync";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { WorldService } from "../Scripts/WorldService";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { ValidateWorldCommand } from "../Commands/ValidateWorldCommand";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { elementNoteType, parseRawFrontmatter, readElement, readFrontmatter, writeElement } from "../vault/element-file";
import { apiDataToFrontmatter, frontmatterToPayloadFields, isPlainKeyName, serializeFrontmatter } from "../vault/element-transform";

const W = "OnlyWorlds/Worlds/W";
const ID = "0199c000-0000-7000-8000-0000000000d1";
const ID2 = "0199c000-0000-7000-8000-0000000000d2";

async function seed(app: ReturnType<typeof makeApp>["app"], path: string, text: string) {
	const folder = path.slice(0, path.lastIndexOf("/"));
	if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
	return (await app.vault.create(path, text)) as unknown as TFile;
}

const engineOf = (app: ReturnType<typeof makeApp>["app"]) =>
	new AutoSyncEngine(app, { settings: { autoSync: true, debounceMs: 1 }, registerEvent: () => undefined, setSyncStatus: () => undefined } as never) as unknown as {
		isElementFile(f: TFile): Promise<boolean>;
	};

test("★ auto-sync says nothing about a person's own note in a type-named folder outside Elements/", async () => {
	const { app } = makeApp();
	const own = await seed(app, `${W}/Sessions/Event/Session 3.md`, "---\ntags: [session]\n---\nNotes.\n");
	const noFm = await seed(app, `${W}/Sessions/Map/Plan.md`, "Just a plan.\n");
	const other = await seed(app, `${W}/Notes/Character/Idea.md`, "---\nid: idea-20231122\nname: Idea\n---\nA note.\n");
	const engine = engineOf(app);
	assert.equal(await engine.isElementFile(own), false);
	assert.equal(await engine.isElementFile(noFm), false);
	assert.equal(await engine.isElementFile(other), false, "another plugin's id is not an element's outside Elements/");
});

test("auto-sync still syncs the plugin's own folders, and a typed note with a UUID id anywhere in the world", async () => {
	const { app } = makeApp();
	const inElements = await seed(app, `${W}/Elements/Character/Ireena.md`, "---\nname: Ireena\nid: legacy-id\n---\n");
	const spanNote = await seed(app, `${W}/Elements/Character/Old.md`, "- <span class=\"text-field\" data-tooltip=\"Text\">Id</span>: x\n");
	const typed = await seed(app, `${W}/Cast/Yuma.md`, `---\nname: Yuma\nid: ${ID}\ntype: location\n---\n`);
	const typeless = await seed(app, `${W}/Cast/Typeless.md`, `---\nname: T\nid: ${ID2}\n---\n`);
	const engine = engineOf(app);
	assert.equal(await engine.isElementFile(inElements), true);
	assert.equal(await engine.isElementFile(spanNote), true);
	assert.equal(await engine.isElementFile(typed), true);
	assert.equal(await engine.isElementFile(typeless), false);
});

test("★ an id that is not a UUID is an element's only under Elements/: a note with another plugin's id in a type-named folder elsewhere is the person's own", () => {
	assert.equal(elementNoteType(`${W}/Notes/Character/Idea.md`, { id: "idea-20231122" }), null);
	assert.equal(elementNoteType(`${W}/Notes/Character/Idea.md`, { id: ID })?.category, "Character");
	assert.equal(elementNoteType(`${W}/Elements/Character/Old.md`, { id: "legacy-id" })?.category, "Character");
});

test("★ a body section headed Properties is prose, and never replaces the group of the person's own properties", async () => {
	const { app, vault } = makeApp();
	const f = await vault.seed(`${W}/Elements/Character/Ireena.md`, `---\nname: Ireena\nid: ${ID}\nstatus: draft\nmood: tense\n---\n\n### Description\n\nA noble.\n\n### Properties\n\nShe owns three houses.\n`);
	const read = await readElement(app, f as unknown as TFile);
	assert.deepEqual(read?.fields.x_properties, { status: "draft", mood: "tense" });
	assert.match(String(read?.fields.description), /She owns three houses\./, "the section is kept as prose, not dropped");
});

test("★ a property may be named anything: it is written as a quoted key when it needs one, and comes back as the same name", async () => {
	const names = ["a: b", "#x", "[x]", "- y", "", "yes", "007", " pad", "0x10", "1e3", "0o17", "Ireena's sword", "HP/MP", "Age (years)", "quote\"d", "multi\nline"];
	for (const n of names.slice(0, 8)) assert.equal(isPlainKeyName(n), false, JSON.stringify(n));
	for (const n of ["status", "Home town", "star-sign", "Résidence", "level 2", "x2"]) assert.equal(isPlainKeyName(n), true, n);
	const group: Record<string, unknown> = { status: "ok", "Home town": "Gela" };
	names.forEach((n, i) => { group[n] = `v${i}`; });
	const fm = apiDataToFrontmatter({ name: "Ireena", x_properties: group }, "character", ID);
	assert.equal(fm.status, "ok");
	assert.equal(fm["Ireena's sword"], "v11");
	assert.equal("x_properties" in fm, false, "every name is a property of the note");
	const yaml = serializeFrontmatter(fm);
	const back = parseRawFrontmatter(yaml);
	assert.ok(back, "the front matter no longer parses: " + yaml);
	assert.deepEqual(frontmatterToPayloadFields(back as Record<string, unknown>, "character").x_properties, group);
});

test("★ a pull never changes a typed note's type through an entry named type in the server's group", async () => {
	const { app, vault } = makeApp();
	const path = `${W}/Cast/Ireena.md`;
	await vault.createFolder(`${W}/Cast`);
	await vault.seed(path, `---\nname: Ireena\nid: ${ID}\ntype: Character\n---\n\n### Description\n\nA noble.\n`);
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", x_properties: { type: "Hero", mood: "calm" } });
	const text = vault.contentAt(path) ?? "";
	assert.match(text, /^type: Character$/m, text);
	assert.match(text, /^mood: calm$/m, text);
	assert.ok(await readElement(app, app.vault.getAbstractFileByPath(path) as unknown as TFile), "the note stopped being an element's");
});

test("a pull keeps the group a person typed into a note when the element arrives with none", async () => {
	const { app, vault } = makeApp();
	const path = `${W}/Elements/Character/Ireena.md`;
	await vault.seed(path, `---\nname: Ireena\nid: ${ID}\nx_properties:\n  a: 1\n---\n\n### Description\n\nA noble.\n`);
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble." });
	assert.match(vault.contentAt(path) ?? "", /x_properties:/);
});

test("★ a co-author's edit to a property with an unusual name reaches the note, and a save sends it back unchanged", async () => {
	const { app, vault } = makeApp();
	const path = `${W}/Elements/Character/Ireena.md`;
	await vault.seed(path, `---\nname: Ireena\nid: ${ID}\n"Ireena's sword": Old blade\n---\n\n### Description\n\nA noble.\n`);
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", x_properties: { "Ireena's sword": "Glamdring, reforged" } });
	const read = await readElement(app, app.vault.getAbstractFileByPath(path) as unknown as TFile);
	assert.deepEqual(read?.fields.x_properties, { "Ireena's sword": "Glamdring, reforged" });
	assert.equal(read?.ownConflicts, undefined);
});

test("★ a server entry named like one of the note's own keys that the save never reads as a property (tags, an x_ key) stays in the group, and goes back", async () => {
	const { app, vault } = makeApp();
	const path = `${W}/Elements/Character/Ireena.md`;
	await vault.seed(path, `---\nname: Ireena\nid: ${ID}\ntags:\n  - npc\nx_rank: captain\n---\n\n### Description\n\nA noble.\n`);
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", x_properties: { tags: ["from-the-web"], x_rank: "general", mood: "tense" } });
	const read = await readElement(app, app.vault.getAbstractFileByPath(path) as unknown as TFile);
	assert.deepEqual(read?.fields.x_properties, { tags: ["from-the-web"], x_rank: "general", mood: "tense" });
	assert.match(vault.contentAt(path) ?? "", /^tags:\n  - npc$/m, "the note's own tags are left as they are");
});

test("★ a `type` entry in the server's group, on a note read by its type property, is kept in the group and not lost at the next save", async () => {
	const { app, vault } = makeApp();
	const path = `${W}/Cast/Ireena.md`;
	await vault.createFolder(`${W}/Cast`);
	await vault.seed(path, `---\nname: Ireena\nid: ${ID}\ntype: Character\n---\n\n### Description\n\nA noble.\n`);
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", x_properties: { type: "Hero", mood: "tense" } });
	const read = await readElement(app, app.vault.getAbstractFileByPath(path) as unknown as TFile);
	assert.equal(read?.category, "character");
	assert.deepEqual(read?.fields.x_properties, { type: "Hero", mood: "tense" });
});

test("★ a pull writes each element with no scan of the world's notes when the plan found its note, and a cold cache costs no quadratic reads", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	await vault.createFolder(`${W}/Elements`);
	await vault.createFolder(`${W}/Diary`);
	for (let i = 0; i < 30; i++) await vault.create(`${W}/Diary/Day ${i}.md`, `Plain note ${i}.\n`);
	const els = Array.from({ length: 30 }, (_, i) => ({ id: `0199c000-0000-7000-8000-${String(i).padStart(12, "0")}`, name: `Person ${i}`, description: "A person." }));
	(app.metadataCache as unknown as { coldCache: boolean }).coldCache = true;
	let reads = 0;
	const realRead = app.vault.read.bind(app.vault);
	(app.vault as unknown as { read: (f: TFile) => Promise<string> }).read = async (f: TFile) => { reads++; return realRead(f); };
	const { DownloadWorldCommand } = await import("../Commands/DownloadWorldCommand");
	await new DownloadWorldCommand(app, {}).generateElementNotes(`${W}/Elements`, { Character: els }, false);
	// the plan reads every note of the world once (60 at most); a scan per element would read ~30 x 60
	assert.ok(reads < 400, `reads ${reads}`);
});

test("★ a cold metadata cache does not make a typed note look like no element's", async () => {
	const { app } = makeApp();
	const f = await seed(app, `${W}/Cast/Yuma.md`, `---\nname: Yuma\nid: ${ID}\ntype: location\n---\n`);
	(app.metadataCache as unknown as { coldCache: boolean }).coldCache = true;
	assert.equal(elementNoteType(f.path, (await readFrontmatter(app, f)) ?? undefined)?.category, "Location");
	const cmd = new SaveElementCommand(app, {} as never) as unknown as { extractPathInfo(p: string): Promise<{ category: string } | null> };
	assert.equal((await cmd.extractPathInfo(f.path))?.category, "Location");
});

test("★ two notes holding one id are both refused by Upload and by the folder export, neither sent", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await seed(app, `${W}/Elements/Character/Ireena.md`, `---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nLive.\n`);
	await seed(app, `${W}/Archive/Character/Ireena (old).md`, `---\nname: Ireena (old)\nid: ${ID}\n---\n\n### Description\n\nOld.\n`);
	await seed(app, `${W}/Elements/Character/Kolyan.md`, `---\nname: Kolyan\nid: ${ID2}\n---\n\n### Description\n\nHere.\n`);
	const up = new ExportWorldCommand(app, {} as never, new WorldService(app));
	const { data: collected, run } = await up.collectRun("W");
	const data = collected as Record<string, { id?: string }[]>;
	assert.deepEqual((data.Character ?? []).map((e) => e.id), [ID2]);
	assert.ok(run.refusedNotes.some((n) => /another note holds the same id/.test(n)));
	const before = new Set(vault.files.keys());
	await (new ExportFolderCommand(app) as unknown as { exportWorld(w: string, d: { kind: "vault" }): Promise<void> }).exportWorld("W", { kind: "vault" });
	const out = [...vault.files.keys()].filter((p) => !before.has(p) && /elements\/character\//.test(p));
	assert.equal(out.length, 1, JSON.stringify(out));
	assert.match(out[0], /kolyan/);
});

test("Validate world does not count a plain note in a type-named folder as an element, and still validates an old span note", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	await seed(app, `${W}/Sessions/Event/Plan.md`, "Just a plan.\n");
	const cmd = new ValidateWorldCommand(app, {} as never, new WorldService(app), false);
	await cmd.execute("W");
	assert.equal(cmd.elementCount, 0);
	assert.equal(cmd.errorCount, 0);
});

test("★ Save refuses a note whose id another element note holds, by name, and sends nothing", async () => {
	const { harnessSave } = await import("./support/save-harness");
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": `---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nLive.\n`,
			"~/Archive/Character/Ireena (old).md": `---\nname: Ireena (old)\nid: ${ID}\n---\n\n### Description\n\nOld.\n`,
		},
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "Live." } },
	});
	assert.equal(r.sent.length, 0);
	assert.ok(r.notices.some((n) => /Ireena not saved: Archive\/Character\/Ireena \(old\)\.md holds the same id/.test(n)), r.notices.join(" | "));
});

test("Save's id index never lets a type-less copy hide the element's note", async () => {
	const { app } = makeApp();
	await seed(app, `${W}/Drafts/A copy.md`, `---\nname: Ireena rewrite\nid: ${ID}\n---\n\nMine.\n`);
	const real = await seed(app, `${W}/Elements/Character/Ireena.md`, `---\nname: Ireena\nid: ${ID}\n---\n`);
	const cmd = new SaveElementCommand(app, {} as never) as unknown as { worldNoteIndex(w: string): Map<string, TFile> };
	assert.equal(cmd.worldNoteIndex("W").get(ID)?.path, real.path);
});

test("the folder export leaves a person's own note in a type-named folder outside Elements/ out of its failures, whatever its id", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	await seed(app, `${W}/Elements/Character/Kolyan.md`, `---\nname: Kolyan\nid: ${ID2}\n---\n\n### Description\n\nHere.\n`);
	await seed(app, `${W}/Sessions/Event/Session 3.md`, "---\ntags: [session]\n---\nNotes.\n");
	await seed(app, `${W}/Notes/Character/Idea.md`, "---\nid: idea-20231122\nname: Idea\n---\nA note.\n");
	await (new ExportFolderCommand(app) as unknown as { exportWorld(w: string, d: { kind: "vault" }): Promise<void> }).exportWorld("W", { kind: "vault" });
	const { __modals } = await import("./support/obsidian-mock");
	const skipped = (__modals.at(-1) as unknown as { failed?: { path: string }[] })?.failed ?? [];
	assert.deepEqual(skipped.map((f) => f.path), [], JSON.stringify(skipped));
});

test("★ the pull's plan reads a note's front matter as Save does: a comment after the type, flow style or a quoted key do not make it miss the note", async () => {
	const { DownloadWorldCommand } = await import("../Commands/DownloadWorldCommand");
	const shapes: Record<string, string> = {
		comment: `---\nname: Ireena\nid: ${ID}\ntype: Character # an NPC\n---\n\n### Description\n\nA noble.\n`,
		flow: `---\n{name: Ireena, id: ${ID}, type: Character}\n---\n\n### Description\n\nA noble.\n`,
		quoted: `---\nname: Ireena\n"id": ${ID}\n'type': Character\n---\n\n### Description\n\nA noble.\n`,
	};
	for (const [shape, text] of Object.entries(shapes)) {
		const { app, vault } = makeApp();
		await vault.seed(`${W}/World.md`, "# World Overview: W\n");
		await vault.createFolder(`${W}/Elements`);
		await seed(app, `${W}/Cast/Ireena.md`, text);
		await new DownloadWorldCommand(app, {}).generateElementNotes(`${W}/Elements`, { Character: [{ id: ID, name: "Ireena", description: "Changed on the server." }] }, false);
		// A hand-made note has no mark, so the pull copies it first into Kept edits/ (a person's own note, not a second element note).
		const mds = [...vault.files.keys()].filter((p) => p.endsWith(".md") && !p.endsWith("World.md") && !p.startsWith(`${W}/Kept edits/`));
		assert.deepEqual(mds, [`${W}/Cast/Ireena.md`], `${shape}: a second note was made: ${JSON.stringify(mds)}`);
		assert.match(vault.contentAt(`${W}/Cast/Ireena.md`) ?? "", /Changed on the server\./, shape);
	}
});

test("★ the writer finds the element's note by id when the plan's note is gone (moved during a long pull)", async () => {
	const { app, vault } = makeApp();
	await vault.createFolder(`${W}/Cast`);
	await vault.seed(`${W}/Cast/Ireena.md`, `---\nname: Ireena\nid: ${ID}\ntype: Character\n---\n\n### Description\n\nA noble.\n`);
	await writeElement(app, "W", "character", ID, { name: "Ireena", description: "Changed on the server." }, { existingPath: `${W}/Elements/Character/Ireena.md` });
	const mds = [...vault.files.keys()].filter((p) => p.endsWith(".md"));
	assert.deepEqual(mds, [`${W}/Cast/Ireena.md`], JSON.stringify(mds));
});

test("★ a property may be named like Object.prototype's members and still travels and comes back", async () => {
	const group = { constructor: "brave", toString: "x", valueOf: 1, hasOwnProperty: "y", ["__proto__"]: "p" } as Record<string, unknown>;
	Object.defineProperty(group, "__proto__", { value: "p", enumerable: true, configurable: true, writable: true });
	const fm = apiDataToFrontmatter({ name: "Ireena", x_properties: group }, "character", ID);
	for (const k of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) assert.ok(Object.prototype.hasOwnProperty.call(fm, k), k);
	const back = parseRawFrontmatter(serializeFrontmatter(fm)) as Record<string, unknown>;
	const sent = frontmatterToPayloadFields(back, "character") as Record<string, unknown>;
	assert.deepEqual(Object.keys(sent.x_properties as object).sort(), ["__proto__", "constructor", "hasOwnProperty", "toString", "valueOf"]);
	for (const top of ["constructor", "toString", "valueOf", "hasOwnProperty"]) assert.equal(Object.prototype.hasOwnProperty.call(sent, top), false, top + " went out as a field");
});

test("a name needs quotes only when a bare key cannot hold it: slashes, brackets and apostrophes stay bare, number-like names are quoted, a very long name stays in the group", () => {
	const yaml = serializeFrontmatter({ name: "I", id: ID, "HP/MP": 1, "Age (years)": 2, "Ireena's sword": 3, "2nd wind": 4, "0x10": 5, "1e3": 6, yes: 7, "a: b": 8 });
	for (const bare of ["HP/MP: 1", "Age (years): 2", "Ireena's sword: 3", "2nd wind: 4"]) assert.ok(yaml.includes("\n" + bare + "\n"), bare + " in " + yaml);
	for (const quoted of ['"0x10": 5', '"1e3": 6', '"yes": 7', '"a: b": 8']) assert.ok(yaml.includes(quoted), quoted + " in " + yaml);
	const long = "x".repeat(1100);
	const fm = apiDataToFrontmatter({ name: "I", x_properties: { [long]: 1 } }, "character", ID);
	assert.deepEqual(fm.x_properties, { [long]: 1 });
});

test("the folder export names an unreadable element note in a type-named folder outside Elements/", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	await seed(app, `${W}/Elements/Character/Kolyan.md`, `---\nname: Kolyan\nid: ${ID2}\n---\n\n### Description\n\nHere.\n`);
	await seed(app, `${W}/Archive/Character/Old.md`, `---\nname: Old\nid: ${ID}\nmood: [unclosed\n---\n\nText.\n`);
	const { __modals } = await import("./support/obsidian-mock");
	const before = __modals.length;
	await (new ExportFolderCommand(app) as unknown as { exportWorld(w: string, d: { kind: "vault" }): Promise<void> }).exportWorld("W", { kind: "vault" });
	assert.ok(__modals.length > before, "the export opened no report");
	const skipped = (__modals.at(-1) as unknown as { failed?: { path: string; reason: string }[] })?.failed ?? [];
	assert.deepEqual(skipped.map((f) => f.path), [`${W}/Archive/Character/Old.md`], JSON.stringify(skipped));
});
