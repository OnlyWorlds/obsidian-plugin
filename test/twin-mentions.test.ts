/**
 * Round C, item 3 (Kael's cold read, 6): prose mentions of two same-named
 * elements imported as `[[Twin]]` twice and exported onto one id, because
 * import wrote the bare name and the folder export's index was keyed by name
 * (the last twin won). A mention now resolves to the note its link points at:
 * import writes the twin's own note, `[[Twin (1)|Twin]]`, and the export
 * resolves each `[[link]]` to its note by path.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";

const WID = "0199c000-0000-7000-8000-0000000000ee";
const T1 = "0199c000-0000-7000-8000-0000000000a1";
const T2 = "0199c000-0000-7000-8000-0000000000a2";
const H = "0199c000-0000-7000-8000-0000000000a3";
const PROSE = `Born in [Twin](ow://character/${T2}), not [Twin](ow://character/${T1}).`;

async function importTwins() {
	const { app, vault } = makeApp();
	await vault.seed("in/b/world.json", JSON.stringify({ id: WID, name: "Barovia" }));
	await vault.seed("in/b/elements/character/twin--000000a1.json", JSON.stringify({ id: T1, type: "character", name: "Twin" }));
	await vault.seed("in/b/elements/character/twin--000000a2.json", JSON.stringify({ id: T2, type: "character", name: "Twin" }));
	await vault.seed(
		"in/b/elements/character/holder--000000a3.json",
		JSON.stringify({ id: H, type: "character", name: "Holder", description: PROSE })
	);
	await (new ImportFolderCommand(app) as unknown as { importFolder(d: string): Promise<void> }).importFolder("in/b");
	return { app, vault };
}

test("★ import writes each twin's mention as a link to its own note, the label kept", async () => {
	const { vault } = await importTwins();
	const holder = [...vault.files.keys()].find((p) => p.endsWith("/Holder.md"))!;
	const text = vault.contentAt(holder) ?? "";
	assert.ok(text.includes("Born in [[Twin (1)|Twin]], not [[Twin]]."), text);
});

test("★ import then folder export gives each mention back its own id", async () => {
	const { app, vault } = await importTwins();
	const before = new Set(vault.files.keys());
	await (new ExportFolderCommand(app) as unknown as {
		exportWorld(w: string, d: { kind: "vault" }): Promise<void>;
	}).exportWorld("Barovia", { kind: "vault" });
	const rel = [...vault.files.keys()].find((p) => !before.has(p) && p.includes("/elements/character/holder"))!;
	assert.equal(JSON.parse(vault.contentAt(rel)!).description, PROSE);
});

test("the export resolves a hand-written [[Twin (1)]] to the second twin, never by name", async () => {
	const { app, vault } = makeApp();
	const E = "OnlyWorlds/Worlds/W/Elements/Character";
	await vault.seed(`${E}/Twin.md`, `---\nname: Twin\nid: ${T1}\n---\n\n### Description\n\nThe elder.\n`);
	await vault.seed(`${E}/Twin (1).md`, `---\nname: Twin\nid: ${T2}\n---\n\n### Description\n\nThe younger.\n`);
	await vault.seed(`${E}/Holder.md`, `---\nname: Holder\nid: ${H}\n---\n\n### Description\n\nSee [[Twin (1)]] and [[Twin]].\n`);
	const plan = await (new ExportFolderCommand(app) as unknown as {
		planFiles(w: string, id: string): Promise<{ files: { rel: string; content: string }[] }>;
	}).planFiles("W", WID);
	const holder = plan.files.find((f) => f.rel.includes("holder"))!;
	assert.equal(
		JSON.parse(holder.content).description,
		`See [Twin](ow://character/${T2}) and [Twin](ow://character/${T1}).`
	);
});
