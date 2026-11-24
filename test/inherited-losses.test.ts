/**
 * Losses the released plugin carried into this branch, each a vault where a
 * command lost or leaked a person's writing, run through the real command
 * over an in-memory vault:
 *   1. Update world format read an empty text property as the field's value,
 *      so a note's unsectioned body (its description) was replaced by an empty
 *      section.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, __notices, type MockVault } from "./support/obsidian-mock";
import { W, E } from "./support/four-notes";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";

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
