/**
 * Round C, item 1 (Kael's cold read, 5): a line starting `### ` inside a text
 * value started a new field, and a code fence that never closed swallowed
 * every section after it.
 *
 * Now a value line that would read as a heading is written with one more
 * leading backslash (`\### `, Markdown's own escape) and read back without
 * it, so the value round-trips byte for byte and no field is invented. A note
 * whose fence never closes is refused by Save, Upload World and the folder
 * export, with the field and the line named, never sent cut short.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { buildElementBody, bodyToFieldValues } from "../vault/element-transform";
import { readElement, writeElement } from "../vault/element-file";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { harnessSave } from "./support/save-harness";
import { harnessUpload } from "./support/upload-harness";

const ID = "0199c000-0000-7000-8000-0000000000e1";
const OTHER = "0199c000-0000-7000-8000-0000000000e2";

const VALUES: Record<string, string> = {
	description: "intro\n### Background\nfake",
	background: "### Secret Notes\nhidden",
	motivations: "\\### already escaped\n\\\\### twice\r\n### crlf after",
	mentality: "```md\n### inside a fence\n```\n### after the fence",
};

test("★ a value line starting `### ` reads back byte for byte and invents no field (pure)", () => {
	const note = `${buildElementBody(VALUES, "character")}\n`;
	const back = bodyToFieldValues(note, "character");
	for (const [k, v] of Object.entries(VALUES)) assert.equal(back[k], v, k);
	assert.deepEqual(Object.keys(back).filter((k) => k.startsWith("x_")), []);
});

test("the note shows the escape outside a fence and the line as typed inside one", () => {
	const body = buildElementBody(VALUES, "character");
	assert.ok(body.includes("intro\n\\### Background\nfake"), body);
	assert.ok(body.includes("```md\n### inside a fence\n```\n\\### after the fence"), body);
	assert.ok(body.includes("\\\\### already escaped\n\\\\\\### twice"), body);
});

test("★ writeElement then readElement: no x_secret_notes, every value exact", async () => {
	const { app } = makeApp();
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", ...VALUES });
	const parsed = await readElement(app, file as TFile);
	assert.ok(parsed);
	for (const [k, v] of Object.entries(VALUES)) assert.equal(parsed.fields[k], v, k);
	assert.equal("x_secret_notes" in parsed.fields, false);
	assert.equal("x_background" in parsed.fields, false);
});

const UNCLOSED =
	`---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nA noble.\n\n### Background\n\n` +
	"```js\nlet x = 1;\n\n### Physicality\n\nTall.\n";

test("★ Save refuses a note whose code fence never closes, naming the field and the line; nothing is sent", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": UNCLOSED }, save: "Character/Ireena.md", server: { [ID]: { name: "Ireena" } } });
	assert.equal(r.result.ok, false);
	assert.deepEqual(r.sent, [], "a cut-short value was sent");
	const n = r.notices.find((x) => /never closes/.test(x)) ?? "";
	assert.match(n, /line 12/, r.notices.join(" | "));
	assert.match(n, /Background/);
});

test("auto-sync refuses it the same way", async () => {
	const r = await harnessSave({ notes: { "Character/Ireena.md": UNCLOSED }, save: "Character/Ireena.md", manual: false });
	assert.equal(r.result.ok, false);
	assert.deepEqual(r.calls, []);
});

test("a create-first target whose fence never closes stops the save: nothing is created", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": `---\nname: Ireena\nid: ${OTHER}\nfriends:\n  - "[[Kolyan]]"\n---\n\n### Description\n\nNew.\n`,
			"Character/Kolyan.md": UNCLOSED.replace("name: Ireena", "name: Kolyan"),
		},
		save: "Character/Ireena.md",
	});
	assert.equal(r.result.ok, false);
	assert.deepEqual(r.sent, []);
	assert.ok(r.notices.some((x) => /Kolyan/.test(x) && /never closes/.test(x)), r.notices.join(" | "));
});

test("★ Upload World leaves such a note out and names it among the failures", async () => {
	const r = await harnessUpload({
		notes: {
			"Character/Ireena.md": UNCLOSED,
			"Character/Kolyan.md": `---\nname: Kolyan\nid: ${OTHER}\n---\n\n### Description\n\nFine.\n`,
		},
		changes: [{ op: "upsert", type: "character", id: ID, change_seq: 1 }],
	});
	assert.equal(r.patches[ID], undefined, "the cut-short note was sent");
	assert.deepEqual(r.bulkSent.map((e) => e.id), [OTHER]);
	assert.ok(r.notices.some((n) => /1 failed/.test(n)), r.notices.join(" | "));
	assert.ok(r.notices.some((n) => /never closes/.test(n) && /line 12/.test(n)), r.notices.join(" | "));
});

test("★ the folder export refuses it with the reason", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Ireena.md", UNCLOSED);
	await vault.seed(
		"OnlyWorlds/Worlds/W/Elements/Character/Kolyan.md",
		`---\nname: Kolyan\nid: ${OTHER}\n---\n\n### Description\n\nFine.\n`
	);
	const plan = await (new ExportFolderCommand(app) as unknown as {
		planFiles(w: string, id: string): Promise<{ files: { rel: string }[]; failed: { path: string; reason: string }[] }>;
	}).planFiles("W", "0199c000-0000-7000-8000-0000000000ee");
	assert.equal(plan.failed.length, 1, JSON.stringify(plan.failed));
	assert.match(plan.failed[0].reason, /never closes/);
	assert.ok(!plan.files.some((f) => f.rel.includes("ireena")), "the cut-short note was written");
});
