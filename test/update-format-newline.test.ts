/**
 * Round C, item 11: Update World Format wrote the new body without the one
 * newline writeElement ends a note with, so the last value's own final
 * newline was read away; and a 3.0/3.1 note's whole-body description was
 * trimmed. Both now read back as a save read them before the update.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { readElement } from "../vault/element-file";
import { bodyTextFields } from "../vault/element-transform";

const ID = "0199c000-0000-7000-8000-0000000000e1";
const PATH = "OnlyWorlds/Worlds/W/Elements/Character/Ireena.md";

async function updateAndRead(content: string) {
	const { app, vault } = makeApp();
	const file = (await vault.seed(PATH, content)) as unknown as TFile;
	// The frontmatter step is not what these tests read: let it run on a copy.
	(app as unknown as { fileManager: Record<string, unknown> }).fileManager.processFrontMatter = async (
		_f: unknown,
		fn: (fm: Record<string, unknown>) => void
	) => fn({});
	const before = await readElement(app, file);
	const cmd = new UpdateWorldFormatCommand(app) as unknown as {
		buildPlan(w: string): Promise<{ notes: unknown[] }>;
		apply(p: unknown): Promise<void>;
	};
	const plan = await cmd.buildPlan("W");
	assert.ok(plan.notes.length > 0, "nothing to update");
	await cmd.apply(plan);
	return { before, after: await readElement(app, file), text: vault.contentAt(PATH) };
}

test("★ the last value keeps its final newline through Update World Format", async () => {
	const last = bodyTextFields("character").at(-1)!;
	const heading = last.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
	// What writeElement writes for a last value "Feared.\n": the value, the layout's blank line, the note's newline.
	const r = await updateAndRead(`---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nA noble.\n\n### ${heading}\n\nFeared.\n\n\n`);
	assert.equal(r.before?.fields[last], "Feared.\n");
	assert.equal(r.after?.fields[last], "Feared.\n", r.text);
	assert.equal(r.after?.fields.description, "A noble.");
});

test("a 3.0/3.1 note's whole-body description keeps its edge whitespace", async () => {
	const r = await updateAndRead(`---\nname: Ireena\nid: ${ID}\n---\n\n  An indented noble.  \n`);
	assert.equal(r.before?.fields.description, "  An indented noble.  ");
	assert.equal(r.after?.fields.description, "  An indented noble.  ", r.text);
});
