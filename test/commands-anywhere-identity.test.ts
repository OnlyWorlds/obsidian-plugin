/**
 * Identity and the person's writing, through Copy world, Upload world, Migrate,
 * Import folder and Update world format: a note's id as the YAML reader reads
 * it (a quoted key, a comment after the value), old span markup that is only
 * an example (in front matter, inline code, an indented block, a fence in a
 * list, after a fence that never closes), front matter the line-keeping edit
 * cannot keep, a text property that is no text, the note Copy writes its
 * output to, and a note with CRLF line endings. Built from two cold reads'
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
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { WorldService } from "../Scripts/WorldService";

const A = "019c0000-0000-7000-8000-0000000000a1";
const B = "019c0000-0000-7000-8000-0000000000b1";
const C = "019c0000-0000-7000-8000-0000000000c1";
const D = "019c0000-0000-7000-8000-0000000000d1";
const CC = "019c0000-0000-7000-8000-0000000000cc";
const BA = "019c0000-0000-7000-8000-0000000000ba";
const BD = "019c0000-0000-7000-8000-0000000000bd";

const ID_LINE = (id: string) => `- <span class="text-field" data-tooltip="Text">Id</span>: ${id}`;
const SPAN = (id: string, name: string, text: string, indent = "") =>
	`${indent}## Base\n${indent}${ID_LINE(id)}\n` +
	`${indent}- <span class="text-field" data-tooltip="Text">Name</span>: ${name}\n` +
	`${indent}- <span class="text-field" data-tooltip="Text">Description</span>: ${text}\n`;

type MigrationReport = { converted: string[]; skipped: string[]; failed: { path: string; reason: string }[]; unresolvedLinks: { path: string; names: string[] }[] };

async function migrate(app: App): Promise<MigrationReport | null> {
	__modals.length = 0;
	__notices.length = 0;
	await (new MigrateWorldCommand(app) as unknown as { migrateWorld(w: string): Promise<void> }).migrateWorld("W");
	return (__modals.at(-1) as unknown as { result?: MigrationReport } | undefined)?.result ?? null;
}

type Plan = { scanned: number; notes: { path: string }[] };
function updater(app: App) {
	return new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<Plan>; apply(p: Plan): Promise<void> };
}
async function update(app: App): Promise<Plan> {
	__notices.length = 0;
	const cmd = updater(app);
	const plan = await cmd.buildPlan("W");
	await cmd.apply(plan);
	return plan;
}

async function seedAll(vault: MockVault, notes: Record<string, string>): Promise<void> {
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	for (const [p, t] of Object.entries(notes)) await vault.seed(p, t);
}

function assertUnchanged(vault: MockVault, notes: Record<string, string>): void {
	for (const [p, t] of Object.entries(notes)) assert.equal(vault.contentAt(p), t, `${p} was rewritten:\n${vault.contentAt(p)}`);
}

// --- 1 an id as the YAML reader reads it ---------------------------------------------

test("★ Migrate never converts a note whose front matter holds an id under a quoted key", async () => {
	const { app, vault } = makeApp();
	const mine = { [`${E}/Character/Mine.md`]: `---\n"id": ${A}\nname: Mine\n---\n\nMy prose.\n\n${SPAN(B, "Example", "Example only.")}` };
	await seedAll(vault, mine);
	const r = await migrate(app);
	assertUnchanged(vault, mine);
	assert.deepEqual(r?.converted ?? [], [], JSON.stringify(r));
});

test("★ Import folder holds an id written with a comment after it, or under a quoted key, with a cold cache", async () => {
	const { app, vault, cache } = makeApp();
	await seedAll(vault, {
		[`${E}/Drafts/Bob.md`]: `---\nid: ${A} # this is Bob\nname: Bob\n---\n\nMy edits.\n`,
		[`${E}/Drafts/Carl.md`]: `---\n"id": ${C}\nname: Carl\n---\n\nMine.\n`,
	});
	cache.coldCache = true;
	const dir = "import/w";
	await vault.seed(`${dir}/world.json`, JSON.stringify({ id: "0199aaaa-0000-7000-8000-0000000000f0", name: "W" }));
	await vault.seed(`${dir}/elements/character/bob.json`, JSON.stringify({ type: "character", id: A, name: "Bob" }));
	await vault.seed(`${dir}/elements/character/carl.json`, JSON.stringify({ type: "character", id: C, name: "Carl" }));
	__modals.length = 0;
	await (new ImportFolderCommand(app) as unknown as { importFolder(dir: string): Promise<void> }).importFolder(dir);
	const r = (__modals.find((m) => m.constructor.name === "ImportReportModal") as unknown as { result: { created: string[]; skipped: string[] } }).result;
	assert.deepEqual(r.skipped.sort(), [A, C].sort(), JSON.stringify(r));
	assert.equal(vault.contentAt(`${E}/Character/Bob.md`), undefined, "a second note with one id was made");
	assert.equal(vault.contentAt(`${E}/Character/Carl.md`), undefined, "a second note with one id was made");
});

test("★ Update world format reads an element's id under a quoted key, or with a comment after it", async () => {
	const { app, vault } = makeApp();
	await seedAll(vault, {
		[`${E}/Character/Quoted key.md`]: `---\nname: Quoted key\n"id": ${A}\n---\n\nA legacy body.\n`,
		[`${E}/Character/Commented.md`]: `---\nname: Commented\nid: ${B} # local id\n---\n\nA legacy body.\n`,
	});
	const plan = await updater(app).buildPlan("W");
	assert.deepEqual(plan.notes.map((n) => n.path).sort(), [`${E}/Character/Commented.md`, `${E}/Character/Quoted key.md`], JSON.stringify(plan));
});

// --- 2 old span markup that is only an example -----------------------------------------

test("★ Migrate never reads span markup in front matter, inline code, an indented block, a fence in a list, or after a fence that never closes", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${E}/Location/Gela.md`, SPAN(D, "Gela", "A town."));
	const examples: Record<string, string> = {
		[`${E}/Character/In front matter.md`]: `---\nexample: |\n  ${ID_LINE(B)}\n  - <span class="text-field" data-tooltip="Text">Name</span>: Example\n---\n\nMy note.\n`,
		[`${E}/Character/Inline.md`]: `See \`\n${ID_LINE(B)}\n- <span class="text-field" data-tooltip="Text">Name</span>: Example\n\` for the shape.\n`,
		[`${E}/Character/Indented.md`]: `How the old plugin wrote a note:\n\n${SPAN(B, "Example", "Example.", "    ")}\nMy two pages.\n`,
		[`${E}/Character/List fence.md`]: `- my list item\n\n    \`\`\`\n${SPAN(B, "Example", "Example.", "    ")}    \`\`\`\n\nMine.\n`,
		[`${E}/Character/Unclosed.md`]: `My draft.\n\n\`\`\`\n${SPAN(B, "Example", "Example.")}\nNever closed.\n`,
	};
	await seedAll(vault, examples);
	const r = await migrate(app);
	assertUnchanged(vault, examples);
	assert.deepEqual(r?.converted, [`${E}/Location/Gela.md`], JSON.stringify(r));
});

// --- 3 Copy and Upload: front matter wins -----------------------------------------------

test("★ Copy world reads a note with a front matter id by its front matter, and a span example never becomes or refuses an element", async () => {
	const { app, vault } = makeApp();
	await seedAll(vault, {
		[`${E}/Character/Quoted.md`]: `---\nname: Quoted\nid: ${CC}\n---\n\n### Description\n\nThe real one.\n`,
		[`${W}/Cast/Quoter.md`]: `---\nname: Quoter\nid: ${BA}\ntype: character\n---\n\n### Description\n\nThe old plugin wrote this:\n${ID_LINE(CC)}\nLong prose of mine.\n`,
		[`${E}/Character/Mentions.md`]: `---\nname: Mentions\nid: ${BD}\n---\n\n### Description\n\nAn old line looked like \`- <span class="text-field" data-tooltip="Text">Name</span>: X\`.\n`,
		[`${E}/Character/Fenced.md`]: `My draft.\n\n\`\`\`\n${SPAN(B, "Example", "Example only.")}\`\`\`\n`,
		[`${W}/Cast/Mine.md`]: `---\nname: Mine\nid: ${C}\ntype: character\n---\n\n### Description\n\nI used \`<span class="text-field">\` once.\n`,
		[`${E}/Character/Bob.md`]: `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nBob.\n`,
		[`${E}/Character/Example.md`]: `An example:\n\n\`\`\`\n${SPAN(A, "Bob", "Example.")}\`\`\`\n`,
	});
	__notices.length = 0;
	const data = (await new CopyWorldCommand(app, {} as never, new WorldService(app)).collectWorldData(W)) as Record<string, Record<string, unknown>[]>;
	assert.deepEqual(data.Character.map((e) => `${e.name} ${e.id}`).sort(), [`Bob ${A}`, `Mentions ${BD}`, `Mine ${C}`, `Quoted ${CC}`, `Quoter ${BA}`].sort(), JSON.stringify(data.Character));
	assert.ok(!__notices.some((n) => /not copied/.test(n)), __notices.join(" | "));
	assert.match(String(data.Character.find((e) => e.id === BA)?.description), /Long prose of mine/);
});

test("★ Upload world sends a note with its own id under that id, though its prose quotes another element's old Id line", async () => {
	const r = await harnessUpload({
		notes: { "Character/Quoter.md": `---\nname: Quoter\nid: ${BA}\n---\n\n### Description\n\nThe old plugin wrote this:\n${ID_LINE(CC)}\nLong prose of mine.\n` },
		changes: [],
	});
	const ids = [...r.bulkSent.map((e) => String(e.id)), ...Object.keys(r.patches)];
	assert.deepEqual(ids, [BA], JSON.stringify({ bulk: r.bulkSent, patches: r.patches }));
});

// --- 4 Migrate's links reach every readable old note ------------------------------------

test("★ Migrate resolves a link to an old note it leaves for the person, as before", async () => {
	const { app, vault } = makeApp();
	await seedAll(vault, {
		[`${E}/Character/Ana.md`]: `## Base\n${ID_LINE(A)}\n- <span class="text-field" data-tooltip="Text">Name</span>: Ana\n- <span class="link-field" data-tooltip="Single Location">Location</span>: [[Home]]\n`,
		[`${E}/Places/Home.md`]: SPAN(B, "Home", "Where Ana lives."),
	});
	const r = await migrate(app);
	assert.deepEqual(r?.converted, [`${E}/Character/Ana.md`], JSON.stringify(r));
	assert.deepEqual(r?.unresolvedLinks, [], JSON.stringify(r?.unresolvedLinks));
	assert.match(vault.contentAt(`${E}/Character/Ana.md`) ?? "", /^location: .*Home/m, vault.contentAt(`${E}/Character/Ana.md`));
});

// --- 5 front matter the line-keeping edit cannot keep: refused, never rebuilt ------------

test("★ Update world format refuses a note whose front matter it cannot keep line for line, names it, and writes nothing", async () => {
	const { app, vault } = makeApp();
	const notes = { [`${E}/Character/Zel.md`]: `---\nname: Zel\nid: ${A}\nbase: &b {hp: 3}\nother: *b\nphysicality: Tall.\nfounded: 2024-03-01   # my date\n---\n\nA legacy body.\n` };
	await seedAll(vault, notes);
	await update(app);
	assertUnchanged(vault, notes);
	assert.ok(__notices.some((n) => /Zel not updated/.test(n)), __notices.join(" | "));
});

test("★ Migrate refuses an old note whose front matter cannot be read or kept, names it, and writes nothing", async () => {
	const { app, vault } = makeApp();
	const notes = {
		[`${E}/Location/Selinus.md`]: `---\ntags: [a, b\nmood: calm\n---\n${SPAN(A, "Selinus", "A temple town.")}`,
		[`${E}/Location/Akragas.md`]: `---\nbase: &b {hp: 3}\nother: *b\n---\n${SPAN(B, "Akragas", "A hill town.")}`,
	};
	await seedAll(vault, notes);
	const r = await migrate(app);
	assertUnchanged(vault, notes);
	assert.deepEqual(r?.converted ?? [], [], JSON.stringify(r));
	assert.deepEqual((r?.failed ?? []).map((f) => f.path).sort(), Object.keys(notes).sort(), JSON.stringify(r?.failed));
});

test("★ a comment above a property stays when the property before it moves to the body", async () => {
	const { app, vault } = makeApp();
	const path = `${E}/Character/Kol.md`;
	await seedAll(vault, { [path]: `---\nname: Kol\nid: ${A}\n# what the book says\nphysicality: Tall\n# from the book, ch. 3\nage: 5\n---\n\nA legacy body.\n` });
	await update(app);
	const text = vault.contentAt(path) ?? "";
	assert.match(text, /\n# what the book says\n# from the book, ch\. 3\nage: 5\n/, text);
	assert.doesNotMatch(text.split("\n---")[0], /physicality/, text);
});
