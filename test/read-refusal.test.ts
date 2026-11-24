/**
 * A heading that starts two sections leaves readElement's `fields` holding
 * only the last one's text. Save refused such a note on its own path, but
 * every other reader that sends, copies or writes a note's fields took the
 * cut text: Upload world, Save's create-first targets, Copy world and the
 * folder export. Now each asks the one check (readRefusal), which refuses an
 * unclosed fence and a repeated heading alike; a note without either goes as
 * before.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, __notices, __modals } from "./support/obsidian-mock";
import { harnessSave } from "./support/save-harness";
import { harnessUpload } from "./support/upload-harness";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { WorldService } from "../Scripts/WorldService";
import { readRefusal } from "../vault/element-file";

const W = "OnlyWorlds/Worlds/W";
const BOB = "019e0000-0000-7000-8000-0000000000c1";
const KAI = "019e0000-0000-7000-8000-0000000000c2";
const IREENA = "019e0000-0000-7000-8000-0000000000c3";

const TWICE = `---\nname: Bob\nid: ${BOB}\n---\n\n### Description\n\nMy only chapter.\n\n### Description\n\nA new summary.\n`;
const ONCE = `---\nname: Bob\nid: ${BOB}\n---\n\n### Description\n\nMy only chapter.\n`;
const KAI_NOTE = `---\nname: Kai\nid: ${KAI}\n---\n\n### Description\n\nFine.\n`;

/** A message that names Bob's note, the command's verdict and the heading typed twice. */
const named = (messages: string[], verb = "not sent") =>
	messages.some((n) => /Bob"? /.test(n) && n.includes(verb) && n.includes('"Description"') && /there twice/.test(n));

test("readRefusal: a fence first, then a repeated heading, else null; the outcome only when given", () => {
	const fence = { field: "Background", line: 12, heading: "Physicality" };
	assert.match(readRefusal({ unclosedFence: fence, repeatedHeadings: ["Description"] }, "Bob") ?? "", /^Bob not sent: the code fence on line 12/);
	const twice = readRefusal({ repeatedHeadings: ["Description"] }, "Bob", "not copied") ?? "";
	assert.match(twice, /^Bob not copied: the heading "Description" is there twice/);
	assert.ok(twice.endsWith("Keep one, then try again."), twice);
	assert.ok((readRefusal({ unclosedFence: fence }, "Bob", "not saved", "Nothing was sent.") ?? "").endsWith("try again. Nothing was sent."));
	assert.equal(readRefusal({}, "Bob"), null);
	assert.equal(readRefusal({ repeatedHeadings: [] }, "Bob"), null);
});

test("★ Upload world sends nothing from a note with a field's heading there twice and names it; the other note goes", async () => {
	const r = await harnessUpload({
		notes: { "Character/Bob.md": TWICE, "Character/Kai.md": KAI_NOTE },
		changes: [{ op: "upsert", type: "character", id: BOB, change_seq: 1 }],
	});
	assert.equal(r.patches[BOB], undefined, "the cut note was sent: " + JSON.stringify(r.patches[BOB]));
	assert.ok(!r.bulkSent.some((e) => e.id === BOB), "the cut note was created");
	assert.deepEqual(r.bulkSent.map((e) => e.id), [KAI]);
	assert.ok(named(r.notices), r.notices.join(" | "));
});

test("Upload world still sends a note with each heading once", async () => {
	const r = await harnessUpload({
		notes: { "Character/Bob.md": ONCE, "Character/Kai.md": KAI_NOTE },
		changes: [{ op: "upsert", type: "character", id: BOB, change_seq: 1 }],
	});
	assert.equal(r.patches[BOB]?.description, "My only chapter.", JSON.stringify(r.patches));
	assert.ok(!r.notices.some((n) => /there twice/.test(n)), r.notices.join(" | "));
});

const LINKS_TO_BOB = `---\nname: Ireena\nid: ${IREENA}\nfriends:\n  - "[[Bob]]"\n---\n\n### Description\n\nNew.\n`;

test("★ Save stops before creating a linked note with a field's heading there twice first: nothing is created, the note is named", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": LINKS_TO_BOB, "Character/Bob.md": TWICE }, save: "Character/Ireena.md" });
	assert.equal(r.result.ok, false);
	assert.deepEqual(r.sent, [], "something was sent: " + JSON.stringify(r.sent));
	assert.ok(named(r.notices), r.notices.join(" | "));
});

test("Save still creates a linked note with each heading once first", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": LINKS_TO_BOB, "Character/Bob.md": ONCE }, save: "Character/Ireena.md" });
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	const bob = r.sent.find((e) => e.id === BOB);
	assert.equal(bob?.description, "My only chapter.", JSON.stringify(r.sent));
});

async function seedWorld(bob: string) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n- **API Key:** ow_k_test\n");
	await vault.seed(`${W}/Elements/Character/Bob.md`, bob);
	await vault.seed(`${W}/Elements/Character/Kai.md`, KAI_NOTE);
	__notices.length = 0;
	__modals.length = 0;
	return app as App;
}

const copy = async (app: App) =>
	(await new CopyWorldCommand(app, {} as never, new WorldService(app)).collectWorldData(W)) as Record<string, Record<string, unknown>[]>;

test("★ Copy world leaves a note with a field's heading there twice out of the copy and names it", async () => {
	const data = await copy(await seedWorld(TWICE));
	assert.deepEqual(data.Character.map((e) => e.id), [KAI]);
	assert.ok(named(__notices, "not copied"), __notices.join(" | "));
});

test("Copy world still copies a note with each heading once", async () => {
	const data = await copy(await seedWorld(ONCE));
	assert.deepEqual(data.Character.map((e) => e.id).sort(), [BOB, KAI].sort());
	assert.equal(data.Character.find((e) => e.id === BOB)?.description, "My only chapter.");
	assert.ok(!__notices.some((n) => /there twice/.test(n)), __notices.join(" | "));
});

type Plan = { files: { rel: string }[]; failed: { path: string; reason: string }[] };
const exportPlan = async (app: App) =>
	(new ExportFolderCommand(app) as unknown as { planFiles(w: string, id: string): Promise<Plan> }).planFiles("W", "019e0000-0000-7000-8000-0000000000ee");

test("★ Export as OnlyWorlds folder writes no file for a note with a field's heading there twice and names it", async () => {
	const plan = await exportPlan(await seedWorld(TWICE));
	assert.equal(plan.failed.length, 1, JSON.stringify(plan.failed));
	assert.ok(named(plan.failed.map((f) => f.reason)), JSON.stringify(plan.failed));
	assert.ok(!plan.files.some((f) => f.rel.toLowerCase().includes("bob")), "the cut note was written: " + plan.files.map((f) => f.rel).join(", "));
	assert.ok(plan.files.some((f) => f.rel.toLowerCase().includes("kai")), plan.files.map((f) => f.rel).join(", "));
});

test("Export as OnlyWorlds folder still writes a note with each heading once", async () => {
	const plan = await exportPlan(await seedWorld(ONCE));
	assert.deepEqual(plan.failed, []);
	assert.ok(plan.files.some((f) => f.rel.toLowerCase().includes("bob")), plan.files.map((f) => f.rel).join(", "));
});
