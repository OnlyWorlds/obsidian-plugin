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
