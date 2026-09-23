/**
 * Same-name twins on note paths — a data-loss regression found by the hop-9
 * measurement (2026-09-23), run against the REAL Obsidian-facing wiring through
 * an in-memory vault (test/support/obsidian-mock.ts — its header says what it
 * emulates).
 *
 * ★ Two elements of the same type and the same name shared one note path. The
 * second write overwrote the first, and the folder import still reported both
 * as created — silent whole-element loss.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
const mock = require("./support/obsidian-mock");
import { writeElement, readElement } from "../vault/element-file";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";

const GUARD_A = "019a0000-0000-7000-8000-00000000000a";
const GUARD_B = "019a0000-0000-7000-8000-00000000000b";

async function notesIn(app: any, folder: string): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const f of app.vault.getMarkdownFiles()) {
		if (!f.path.startsWith(folder + "/")) continue;
		const el = await readElement(app, f);
		if (el) out[el.id] = f.path;
	}
	return out;
}

for (const cold of [false, true]) {
	test(`★ two same-type same-name elements get two notes, never one (${cold ? "cold" : "warm"} cache)`, async () => {
		const app = new mock.App();
		app.metadataCache.coldCache = cold;
		await writeElement(app, "W", "character", GUARD_A, { name: "Guard", description: "The first guard." });
		await writeElement(app, "W", "character", GUARD_B, { name: "Guard", description: "The second guard." });
		const folder = "OnlyWorlds/Worlds/W/Elements/Character";
		const a = app.vault.contentAt(`${folder}/Guard.md`);
		const b = app.vault.contentAt(`${folder}/Guard (1).md`);
		assert.ok(a && a.includes(`id: ${GUARD_A}`) && a.includes("The first guard."), "first Guard was overwritten");
		assert.ok(b && b.includes(`id: ${GUARD_B}`) && b.includes("The second guard."), "second Guard has no note of its own");
		// Re-writing an element lands on ITS note — no third file, no swap —
		// even when the metadata cache has not indexed anything yet.
		await writeElement(app, "W", "character", GUARD_B, { name: "Guard", description: "Second, edited." });
		await writeElement(app, "W", "character", GUARD_A, { name: "Guard", description: "First, edited." });
		assert.equal(app.vault.getMarkdownFiles().length, 2);
		assert.match(app.vault.contentAt(`${folder}/Guard.md`), /First, edited\./);
		assert.match(app.vault.contentAt(`${folder}/Guard (1).md`), /Second, edited\./);
	});
}

test("★ folder import of same-name twins creates both notes and counts only what exists", async () => {
	const app = new mock.App();
	mock.__modals.length = 0;
	const dir = "import/twins";
	const worldId = "0199aaaa-0000-7000-8000-000000000000";
	await app.vault.seed(`${dir}/world.json`, JSON.stringify({ id: worldId, name: "Twins" }));
	for (const [id, desc] of [[GUARD_A, "The first guard."], [GUARD_B, "The second guard."]]) {
		await app.vault.seed(
			`${dir}/elements/character/guard--${id.slice(-8)}.json`,
			JSON.stringify({ id, type: "character", name: "Guard", description: desc })
		);
	}
	await (new ImportFolderCommand(app) as any).importFolder(dir);

	const report = mock.__modals.find((m: any) => m.constructor.name === "ImportReportModal");
	assert.ok(report, "no import report");
	const byId = await notesIn(app, "OnlyWorlds/Worlds/Twins/Elements");
	assert.deepEqual(Object.keys(byId).sort(), [GUARD_A, GUARD_B], "an element was lost on import");
	assert.notEqual(byId[GUARD_A], byId[GUARD_B]);
	// the report may only count what actually exists as a note
	assert.deepEqual([...report.result.created].sort(), Object.keys(byId).sort());
	assert.equal(report.result.failed.length, 0);
	const second = await readElement(app, app.vault.getAbstractFileByPath(byId[GUARD_B]));
	assert.equal(second!.fields.description, "The second guard.");
});

test("a note already holding this id is rewritten in place, whatever shape it is in (cold cache)", async () => {
	// findNoteById sees nothing on a cold cache, so the name-based path is the
	// only route to these notes — claiming a NEW path would duplicate them.
	const folder = "OnlyWorlds/Worlds/W/Elements/Character";
	const shapes: Record<string, string> = {
		"leading blank lines (the corruption a rewrite heals)": `\n\n---\nid: ${GUARD_A}\nname: Guard\n---\n\nOld.\n`,
		"legacy span note": `## Base\n- <span class="text-field" data-tooltip="Text">Id</span>: ${GUARD_A}\n- <span class="text-field" data-tooltip="Text">Name</span>: Guard\n`,
	};
	for (const [label, content] of Object.entries(shapes)) {
		const app = new mock.App();
		app.metadataCache.coldCache = true;
		await app.vault.seed(`${folder}/Guard.md`, content);
		await writeElement(app, "W", "character", GUARD_A, { name: "Guard", description: "Rewritten." });
		assert.equal(app.vault.getMarkdownFiles().length, 1, `${label}: a duplicate note was minted`);
		assert.match(app.vault.contentAt(`${folder}/Guard.md`), /^---\nname: Guard\nid: /, label);
	}
});

test("a caller-chosen fileName held by another element is not overwritten either", async () => {
	const app = new mock.App();
	const folder = "OnlyWorlds/Worlds/W/Elements/Character";
	await writeElement(app, "W", "character", GUARD_A, { name: "Guard", description: "The first guard." });
	await writeElement(app, "W", "character", GUARD_B, { name: "Guard", description: "The second guard." }, {
		folderPath: folder,
		fileName: "Guard.md",
	});
	assert.match(app.vault.contentAt(`${folder}/Guard.md`), /The first guard\./);
	assert.match(app.vault.contentAt(`${folder}/Guard (1).md`), /The second guard\./);
});
