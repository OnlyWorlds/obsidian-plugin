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
