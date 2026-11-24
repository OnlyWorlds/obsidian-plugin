/**
 * Copy world, Migrate, Import folder and Update world format, on the vaults two
 * cold readers built against the notes-anywhere change: a person's note that
 * quotes old span markup, a front matter that is the person's own writing (a
 * date, a map, `.inf`, a block string), an id that is no element's, a note the
 * metadata cache has not read, two notes with one id, and a note where Copy
 * writes its output. Each runs through the real command and an in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __modals, __notices, type MockVault } from "./support/obsidian-mock";
import { W, E } from "./support/four-notes";
import { MigrateWorldCommand } from "../Commands/MigrateWorldCommand";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { WorldService } from "../Scripts/WorldService";
import { serializeFrontmatter } from "../vault/element-transform";

const SPAN = (id: string, name: string, text: string) =>
	`## Base\n- <span class="text-field" data-tooltip="Text">Id</span>: ${id}\n` +
	`- <span class="text-field" data-tooltip="Text">Name</span>: ${name}\n` +
	`- <span class="text-field" data-tooltip="Text">Description</span>: ${text}\n`;

type MigrationReport = { converted: string[]; skipped: string[]; failed: { path: string; reason: string }[]; left?: { path: string; reason: string }[] };

async function migrate(app: App): Promise<MigrationReport | null> {
	__modals.length = 0;
	__notices.length = 0;
	await (new MigrateWorldCommand(app) as unknown as { migrateWorld(w: string): Promise<void> }).migrateWorld("W");
	const m = __modals.at(-1) as unknown as { result?: MigrationReport } | undefined;
	return m?.result ?? null;
}

const backups = (vault: MockVault) => [...vault.files.keys()].filter((p) => p.startsWith("OW-backup-"));

// --- 1 Migrate: which notes are old span notes ---------------------------------

const GELA = "019b0000-0000-7000-8000-0000000000b1";
const EXAMPLE = "019b0000-0000-7000-8000-0000000000b9";
const QUOTER = "019b0000-0000-7000-8000-0000000000ba";
const QUOTED = "019b0000-0000-7000-8000-0000000000cc";
const DRAFT = "019b0000-0000-7000-8000-0000000000b4";

test("★ Migrate converts a span note only in a type folder under Elements/ with no id in its front matter; quoted, fenced or front-matter notes are never rewritten", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	await vault.seed(`${E}/Location/Gela.md`, SPAN(GELA, "Gela", "A town."));
	const keep: Record<string, string> = {
		// a person's research note in a type-named folder, quoting what the plugin once wrote
		[`${W}/Research/Character/How old notes looked.md`]: `---\ntags: [research]\n---\nThe plugin once wrote:\n${SPAN(EXAMPLE, "Example", "An example.")}My analysis of it, two pages.\n`,
		// an element note whose prose quotes an old Id line of another element
		[`${W}/Cast/Quoter.md`]: `---\nname: Quoter\nid: ${QUOTER}\ntype: character\n---\n\n### Description\n\nThe old plugin wrote this:\n- <span class="text-field" data-tooltip="Text">Id</span>: ${QUOTED}\nLong prose of mine.\n`,
		// the same inside Elements/: a front matter id is never an old note's
		[`${E}/Character/Quoted.md`]: `---\nname: Quoted\nid: ${QUOTER.replace("ba", "bb")}\n---\n\n### Description\n\n- <span class="text-field" data-tooltip="Text">Id</span>: ${QUOTED}\nMine.\n`,
		// a fenced example in a person's note
		[`${W}/Lore/Location/Template notes.md`]: `---\ntags: [reference]\n---\nMy notes on templates.\n\n\`\`\`markdown\n${SPAN(EXAMPLE, "Example", "Example only.")}\`\`\`\n\nMore of mine.\n`,
		// a fenced example inside a type folder under Elements/
		[`${E}/Character/Fenced.md`]: `My draft.\n\n\`\`\`\n${SPAN(EXAMPLE, "Example", "Example only.")}\`\`\`\n`,
		// an old note moved into a folder of no type: left, and said
		[`${E}/Places/Draft.md`]: SPAN(DRAFT, "Draft", "Mine."),
	};
	for (const [p, t] of Object.entries(keep)) await vault.seed(p, t);

	const r = await migrate(app);
	assert.ok(r, "no report: " + __notices.join(" | "));
	assert.deepEqual(r.converted, [`${E}/Location/Gela.md`], JSON.stringify(r));
	for (const [p, t] of Object.entries(keep)) assert.equal(vault.contentAt(p), t, `${p} was rewritten`);
	assert.deepEqual((r.left ?? []).map((l) => l.path).sort(), [`${E}/Places/Draft.md`, `${W}/Research/Character/How old notes looked.md`].sort(), "the old notes left out are not reported: " + JSON.stringify(r.left));
	assert.ok(r.skipped.includes(`${W}/Cast/Quoter.md`) && r.skipped.includes(`${E}/Character/Quoted.md`), JSON.stringify(r.skipped));
	assert.deepEqual(backups(vault).map((p) => p.split("/").slice(1).join("/")), ["Elements/Location/Gela.md"], "the backup holds what was rewritten");
});

test("★ Migrate aborts before any conversion when a note cannot be read, and names it", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	await vault.seed(`${E}/Character/Unreadable.md`, SPAN(DRAFT, "Unreadable", "A."));
	const readable = SPAN(GELA, "Readable", "B.");
	await vault.seed(`${E}/Character/Readable.md`, readable);
	const v = app.vault as unknown as { read(f: TFile): Promise<string> };
	const read = v.read.bind(v);
	v.read = async (f: TFile) => {
		if (f.path.endsWith("Unreadable.md")) throw new Error("EACCES");
		return read(f);
	};
	await migrate(app);
	assert.equal(vault.contentAt(`${E}/Character/Readable.md`), readable, "a note was converted after a read failed");
	assert.deepEqual(backups(vault), []);
	assert.ok(__notices.some((n) => /Unreadable/.test(n) && /aborted/i.test(n)), __notices.join(" | "));
});

// --- 2 a person's front matter is kept line for line ---------------------------

const ZEL = "019b0000-0000-7000-8000-0000000000d2";
const OWN_LINES = [
	"birthday: 2024-01-01",
	"meta: {a: 1, when: 2023-05-05}",
	"dates:",
	"  - 2020-02-02",
	"  - 2021-03-03",
	"limit: .inf",
	'zip: "01234"',
	"motto: |",
	"  first line",
	"  second line",
	"alive: true",
];

test("★ Update world format keeps every property it does not change exactly as the person wrote it, in its place", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	const path = `${E}/Character/Zel.md`;
	await vault.seed(path, `---\nname: Zel\nid: ${ZEL}\n${OWN_LINES.slice(0, 7).join("\n")}\nphysicality: Tall.\n${OWN_LINES.slice(7).join("\n")}\n---\n\nA legacy body.\n`);
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<unknown>; apply(p: unknown): Promise<void> };
	await cmd.apply(await cmd.buildPlan("W"));
	const text = vault.contentAt(path) ?? "";
	const block = text.slice(0, text.indexOf("\n---", 3));
	assert.ok(block.startsWith(`---\nname: Zel\nid: ${ZEL}\n${OWN_LINES.join("\n")}\n`), "the person's lines were rewritten or moved:\n" + block);
	assert.doesNotMatch(block, /physicality/, "a text field stayed in the front matter");
	assert.match(block, /\nheight:/, "the type's missing properties were not added");
	assert.match(text, /### Physicality\n\nTall\./, text);
});

test("★ Migrate keeps an old note's own front matter line for line after the migrated keys, a property named __proto__ included", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	const path = `${E}/Location/Selinus.md`;
	const own = "created: 2024-01-01\nnote: |\n  mine\n  two\n__proto__: {kept: mine}";
	await vault.seed(path, `---\n${own}\n---\n${SPAN(GELA, "Selinus", "A temple town.")}`);
	const r = await migrate(app);
	assert.deepEqual(r?.converted, [path], JSON.stringify(r));
	const text = vault.contentAt(path) ?? "";
	assert.match(text, new RegExp(`^---\\nname: Selinus\\nid: ${GELA}\\n`), text);
	assert.ok(text.includes(`\n${own}\n---`), "the note's own lines were rewritten:\n" + text);
});

test("the serializer writes a date as the plain date and a number YAML calls infinite or not a number as YAML does, in a map or a list too", () => {
	const out = serializeFrontmatter({
		d: new Date("2024-01-01T00:00:00Z"),
		big: Infinity,
		low: -Infinity,
		nan: NaN,
		map: { when: new Date("2023-05-05T00:00:00Z"), inf: Infinity },
		list: [new Date("2020-02-02T00:00:00Z"), 1],
		plain: { a: 1 },
	});
	assert.equal(out, [
		"---",
		"d: 2024-01-01",
		"big: .inf",
		"low: -.inf",
		"nan: .nan",
		'map: {"when": 2023-05-05, "inf": .inf}',
		"list: [2020-02-02, 1]",
		'plain: {"a":1}',
		"---",
	].join("\n"));
});

// --- 3 Update world format: an element's id is a lower-case UUID ------------------

test("★ Update world format leaves a note in a type folder whose id is no element's, and one that only quotes span markup", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	const notes: Record<string, string> = {
		[`${E}/Character/Checklist.md`]: "---\nname: Checklist\nid: checklist-7\n---\n\nMy checklist.\n",
		[`${E}/Character/Upper.md`]: "---\nname: Upper\nid: 019B0000-0000-7000-8000-0000000000E1\n---\n\nShouting.\n",
		[`${E}/Character/Draft.md`]: `---\nname: Draft\n---\n\nAn example of the old format:\n- <span class="text-field" data-tooltip="Text">Description</span>: Example.\n`,
	};
	for (const [p, t] of Object.entries(notes)) await vault.seed(p, t);
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<{ notes: { path: string }[] }>; apply(p: unknown): Promise<void> };
	const plan = await cmd.buildPlan("W");
	assert.deepEqual(plan.notes.map((n) => n.path), [], JSON.stringify(plan.notes));
	await cmd.apply(plan);
	for (const [p, t] of Object.entries(notes)) assert.equal(vault.contentAt(p), t, `${p} was rewritten`);
});

// --- 4 Import folder: an id any note holds is held ----------------------------------

async function importOne(app: App, vault: MockVault, el: Record<string, unknown>): Promise<{ created: string[]; skipped: string[] }> {
	const dir = "import/w";
	await vault.seed(`${dir}/world.json`, JSON.stringify({ id: "0199aaaa-0000-7000-8000-0000000000f0", name: "W" }));
	await vault.seed(`${dir}/elements/character/one.json`, JSON.stringify({ type: "character", ...el }));
	__modals.length = 0;
	await (new ImportFolderCommand(app) as unknown as { importFolder(dir: string): Promise<void> }).importFolder(dir);
	return (__modals.find((m) => m.constructor.name === "ImportReportModal") as unknown as { result: { created: string[]; skipped: string[] } }).result;
}

const BOB = "019b0000-0000-7000-8000-0000000000f1";
const IREENA = "019b0000-0000-7000-8000-0000000000a1";

test("★ Import folder skips an element whose id a note of the person's own holds, typed or not: no second note with one id", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	const mine = `---\nname: Bob\nid: ${BOB}\n---\n\nMy edits.\n`;
	await vault.seed(`${E}/Drafts/Bob.md`, mine);
	const r = await importOne(app, vault, { id: BOB, name: "Bob", description: "Imported." });
	assert.deepEqual(r.skipped, [BOB], JSON.stringify(r));
	assert.equal(vault.contentAt(`${E}/Character/Bob.md`), undefined, "a second note with one id was made");
	assert.equal(vault.contentAt(`${E}/Drafts/Bob.md`), mine);
});

test("★ Import folder reads a held id from the disk when the metadata cache has no front matter for the note", async () => {
	const { app, vault, cache } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	const path = `${E}/Places/Ireena.md`;
	await vault.seed(path, `---\nid: ${IREENA}\nname: Ireena\ntype: character\n---\n\nMy version.\n`);
	const c = cache as unknown as { getFileCache(f: { path: string }): unknown };
	const get = c.getFileCache.bind(c);
	c.getFileCache = (f: { path: string }) => (f.path === path ? {} : get(f));
	const r = await importOne(app, vault, { id: IREENA, name: "Ireena", description: "Imported version." });
	assert.deepEqual(r.skipped, [IREENA], JSON.stringify(r));
	assert.equal(vault.contentAt(`${E}/Character/Ireena.md`), undefined, "a second note with one id was made");
});

// --- 5 Copy world: two notes with one id; its own output note ------------------------

test("★ Copy world refuses two notes holding one id, both named, and copies neither", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	await vault.seed(`${E}/Character/Bob.md`, `---\nname: Bob\nid: ${BOB}\n---\n\n### Description\n\nCurrent.\n`);
	await vault.seed(`${W}/Archive/Character/Bob old.md`, `---\nname: Bob old\nid: ${BOB}\n---\n\n### Description\n\nOld draft.\n`);
	await vault.seed(`${E}/Character/Ireena.md`, `---\nname: Ireena\nid: ${IREENA}\n---\n\n### Description\n\nA noble.\n`);
	__notices.length = 0;
	const data = (await new CopyWorldCommand(app, {} as never, new WorldService(app)).collectWorldData(W)) as Record<string, Record<string, unknown>[]>;
	assert.deepEqual(data.Character.map((e) => e.id), [IREENA], JSON.stringify(data.Character));
	const said = __notices.join(" | ");
	assert.ok(/"Bob" not copied/.test(said) && /"Bob old" not copied/.test(said), said);
});

function withClipboard(): void {
	Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async () => {} } }, configurable: true, writable: true });
}

test("★ Copy world never writes its output over an element note, and names it", async () => {
	withClipboard();
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	const note = `---\nname: World Data File\nid: ${IREENA}\ntype: character\n---\n\n### Description\n\nMy prose.\n`;
	await vault.seed(`${W}/World Data File.md`, note);
	__notices.length = 0;
	await new CopyWorldCommand(app, {} as never, new WorldService(app)).copyWorldData("W");
	assert.equal(vault.contentAt(`${W}/World Data File.md`), note, "an element note was overwritten");
	assert.ok(__notices.some((n) => /World Data File/.test(n) && /element note/.test(n)), __notices.join(" | "));
});

test("Copy world marks its output write as the plugin's own before it writes", async () => {
	withClipboard();
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	await vault.seed(`${W}/World Data File.md`, "{}");
	const order: string[] = [];
	const v = app.vault as unknown as { modify(f: TFile, c: string): Promise<void> };
	const modify = v.modify.bind(v);
	v.modify = async (f: TFile, c: string) => {
		order.push(`modify ${f.path}`);
		return modify(f, c);
	};
	const Copy = CopyWorldCommand as unknown as new (...a: unknown[]) => CopyWorldCommand;
	await new Copy(app, {} as never, new WorldService(app), undefined, (p: string) => order.push(`mark ${p}`)).copyWorldData("W");
	assert.deepEqual(order, [`mark ${W}/World Data File.md`, `modify ${W}/World Data File.md`]);
});
