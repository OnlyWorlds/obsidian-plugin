/**
 * Kael's fixes read, should-fix 1: Manage Fields, Update World Format and
 * Copy/Paste World read a note without checking its unclosed fence. The note
 * Save refuses (a fence typed open that swallows `### Background`) was
 * rebuilt with the opener and the swallowed heading escaped and an empty
 * Background section added, so it parsed cleanly, and the next Save cleared
 * Background on onlyworlds.com. Now those three paths refuse or skip such a
 * note, naming the field and the heading as Save does; nothing is rebuilt.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __notices, __modals, type MockVault } from "./support/obsidian-mock";
import { ManageFieldsCommand } from "../Commands/ManageFieldsCommand";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { WorldService } from "../Scripts/WorldService";

const W = "OnlyWorlds/Worlds/W";
const ID = "0199c000-0000-7000-8000-0000000000fa";
const OTHER = "0199c000-0000-7000-8000-0000000000fb";
const SWALLOWED = `---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nA\n\`\`\`\n\n### Background\n\nHer past.\n`;
const PATH = `${W}/Elements/Character/Ireena.md`;

async function seed() {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n- **API Key:** ow_k_test\n");
	const file = (await vault.seed(PATH, SWALLOWED)) as unknown as TFile;
	await vault.seed(`${W}/Elements/Character/Kolyan.md`, `---\nname: Kolyan\nid: ${OTHER}\n---\n\n### Description\n\nFine.\n`);
	__notices.length = 0;
	__modals.length = 0;
	return { app, vault: vault as unknown as MockVault, file };
}

const named = (notices: string[]) => notices.some((n) => /never closes/.test(n) && /Description/.test(n) && /Background/.test(n));

test("★ Manage Fields refuses the note: no dialog, the file unchanged, the notice names the field and the heading", async () => {
	const { app, vault, file } = await seed();
	(app as unknown as { workspace: { getActiveFile(): TFile } }).workspace.getActiveFile = () => file;
	await new ManageFieldsCommand(app as App).execute();
	assert.equal(__modals.length, 0, "the dialog opened");
	assert.equal(vault.contentAt(PATH), SWALLOWED);
	assert.ok(named(__notices), __notices.join(" | "));
});

test("★ Manage Fields' apply refuses it too (a dialog opened before the fence was typed)", async () => {
	const { app, vault, file } = await seed();
	const cmd = new ManageFieldsCommand(app as App) as unknown as {
		applySelection(f: TFile, c: string, s: Set<string>, ch: unknown[]): Promise<void>;
	};
	await cmd.applySelection(file, "character", new Set(["description", "background", "physicality"]), []);
	assert.equal(vault.contentAt(PATH), SWALLOWED);
	assert.ok(named(__notices), __notices.join(" | "));
});

test("★ Update World Format skips the note and names it; the other notes are updated", async () => {
	const { app, vault } = await seed();
	// The frontmatter step is not what this test reads: let it run on a copy.
	(app as unknown as { fileManager: Record<string, unknown> }).fileManager.processFrontMatter = async (
		_f: unknown,
		fn: (fm: Record<string, unknown>) => void
	) => fn({});
	const cmd = new UpdateWorldFormatCommand(app as App) as unknown as {
		buildPlan(w: string): Promise<{ notes: { path: string; needsReview: boolean }[] }>;
		apply(p: unknown): Promise<void>;
	};
	const plan = await cmd.buildPlan("W");
	assert.equal(plan.notes.find((n) => n.path === PATH)?.needsReview, true, JSON.stringify(plan.notes));
	await cmd.apply(plan);
	assert.equal(vault.contentAt(PATH), SWALLOWED);
	assert.ok(named(__notices), __notices.join(" | "));
});

test("★ Copy World leaves the note out of the copy and names it", async () => {
	const { app } = await seed();
	const data = (await new CopyWorldCommand(app as App, {} as never, new WorldService(app as App)).collectWorldData(W)) as Record<
		string,
		Record<string, unknown>[]
	>;
	assert.deepEqual(data.Character.map((e) => e.id), [OTHER]);
	assert.ok(named(__notices), __notices.join(" | "));
});
