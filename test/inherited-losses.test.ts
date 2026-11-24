/**
 * Losses the released plugin carried into this branch, each a vault where a
 * command lost or leaked a person's writing, run through the real command
 * over an in-memory vault:
 *   1. Update world format read an empty text property as the field's value,
 *      so a note's unsectioned body (its description) was replaced by an empty
 *      section.
 *   2. A heading that starts two sections kept only the last one's text:
 *      Update and Manage fields rebuilt the note from it, Save sent it.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __notices, __modals, type MockVault } from "./support/obsidian-mock";
import { harnessSave } from "./support/save-harness";
import { W, E } from "./support/four-notes";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { ManageFieldsCommand } from "../Commands/ManageFieldsCommand";

const A = "019e0000-0000-7000-8000-0000000000a1";

async function seedAll(vault: MockVault, notes: Record<string, string>): Promise<void> {
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	for (const [p, t] of Object.entries(notes)) await vault.seed(p, t);
}
function assertUnchanged(vault: MockVault, notes: Record<string, string>): void {
	for (const [p, t] of Object.entries(notes)) assert.equal(vault.contentAt(p), t, `${p} was rewritten:\n${vault.contentAt(p)}`);
}
async function update(app: App): Promise<void> {
	__notices.length = 0;
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<unknown>; apply(p: unknown): Promise<void> };
	await cmd.apply(await cmd.buildPlan("W"));
}

// --- 1 an empty text property is no value ------------------------------------------------------

test("★ Update world format keeps a note's unsectioned body as its description when the description property is empty, blank or null", async () => {
	for (const held of ['""', '"   "', "", "null"]) {
		const { app, vault } = makeApp();
		const path = `${E}/Character/Bob.md`;
		await seedAll(vault, { [path]: `---\nname: Bob\nid: ${A}\ndescription: ${held}\n---\n\nMy only chapter.\n` });
		await update(app);
		const text = vault.contentAt(path) ?? "";
		assert.match(text, /### Description\n\nMy only chapter\.\n/, `description: ${held}\n${text}`);
		assert.doesNotMatch(text, /^description:/m, `description: ${held}\n${text}`);
	}
});

test("★ Update world format keeps a narrative's unsectioned body as its story when the story property is empty", async () => {
	const { app, vault } = makeApp();
	const path = `${E}/Narrative/Saga.md`;
	await seedAll(vault, { [path]: `---\nname: Saga\nid: ${A}\nstory: ""\n---\n\nThe only copy of my chapter.\n` });
	await update(app);
	const text = vault.contentAt(path) ?? "";
	assert.match(text, /### Story\n\nThe only copy of my chapter\.\n/, text);
});

test("Update world format still moves a text property with a value into its section, and leaves an empty one's section empty", async () => {
	const { app, vault } = makeApp();
	const path = `${E}/Character/Kai.md`;
	await seedAll(vault, { [path]: `---\nname: Kai\nid: ${A}\nphysicality: Tall.\nmentality: ""\n---\n\nA guard.\n` });
	await update(app);
	const text = vault.contentAt(path) ?? "";
	assert.match(text, /### Description\n\nA guard\.\n/, text);
	assert.match(text, /### Physicality\n\nTall\.\n/, text);
	assert.match(text, /### Mentality\n\n\n### /, text);
	assert.doesNotMatch(text, /^mentality:/m, text);
});

// --- 2 a heading that starts two sections ------------------------------------------------------

const TWICE = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nMy only chapter.\n\n### Description\n\nA new summary.\n`;
const LOOKS_TWICE = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n\n### Looks\n\nMy only portrait.\n\n### looks\n\nTall.\n`;
const twiceNamed = (notices: string[], heading: string, verb: string) =>
	notices.some((n) => n.startsWith(`Bob ${verb}`) && n.includes(`"${heading}"`) && /there twice/.test(n) && /Keep one, then try again/.test(n));

test("★ Update world format leaves a note with a heading there twice byte for byte, and names the heading", async () => {
	for (const [body, heading] of [[TWICE, "Description"], [LOOKS_TWICE, "Looks"]] as const) {
		const { app, vault } = makeApp();
		const notes = { [`${E}/Character/Bob.md`]: body };
		await seedAll(vault, notes);
		await update(app);
		assertUnchanged(vault, notes);
		assert.ok(twiceNamed(__notices, heading, "not updated"), __notices.join(" | "));
	}
});

test("★ Save sends nothing from a note with a field's heading there twice, by hand or by auto-sync, and says it once a session by auto-sync", async () => {
	for (const body of [TWICE, LOOKS_TWICE]) {
		const server = { [A]: { name: "Bob", description: "Server text." } };
		const heading = body === TWICE ? "Description" : "Looks";
		const byHand = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server, manual: true });
		assert.deepEqual(byHand.calls, [], `${heading}: ` + byHand.calls.join(" | "));
		assert.ok(twiceNamed(byHand.notices, heading, "not saved"), byHand.notices.join(" | "));
		assert.equal(byHand.vault.contentAt(`${E}/Character/Bob.md`), body);
		const auto = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server, manual: false });
		assert.deepEqual(auto.calls, [], auto.calls.join(" | "));
		assert.equal(auto.result.ok, false);
		const again = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server, manual: false });
		assert.deepEqual(again.calls, []);
		assert.deepEqual(again.notices, [], "auto-sync said it again: " + again.notices.join(" | "));
	}
});

test("Save still sends a note whose repeated heading is prose it folds into the description: both sections travel", async () => {
	const body = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n\n### The war, part one\n\nFirst.\n\n### The war, part one\n\nSecond.\n`;
	const saved = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server: { [A]: { name: "Bob", description: "Old." } }, manual: true });
	assert.deepEqual(saved.calls, [`get character ${A}`, `update character ${A}`], saved.calls.join(" | ") + " :: " + saved.notices.join(" | "));
	const sent = String(saved.sent[0]?.description);
	assert.ok(sent.includes("First.") && sent.includes("Second."), sent);
});

test("★ Manage fields leaves a note with a heading there twice, from the command and from a dialog opened before", async () => {
	for (const [body, heading] of [[TWICE, "Description"], [LOOKS_TWICE, "Looks"]] as const) {
		const { app, vault } = makeApp();
		const path = `${E}/Character/Bob.md`;
		await seedAll(vault, { [path]: body });
		const file = app.vault.getAbstractFileByPath(path) as TFile;
		(app as unknown as { workspace: { getActiveFile(): TFile } }).workspace.getActiveFile = () => file;
		__notices.length = 0;
		__modals.length = 0;
		await new ManageFieldsCommand(app).execute();
		assert.equal(__modals.length, 0, "the dialog opened");
		assert.ok(twiceNamed(__notices, heading, "not changed"), __notices.join(" | "));
		__notices.length = 0;
		const cmd = new ManageFieldsCommand(app) as unknown as { applySelection(f: TFile, c: string, s: Set<string>, ch: unknown[]): Promise<void> };
		await cmd.applySelection(file, "character", new Set(["description", "physicality"]), []);
		assert.equal(vault.contentAt(path), body);
		assert.ok(twiceNamed(__notices, heading, "not changed"), __notices.join(" | "));
	}
});
