/**
 * Copy World and Upload World walk a type's folder; a relationship canvas
 * (and a user's copy of one) sits there beside its note. The walks take only
 * Markdown notes (Kael's seam read of rc-350, should-fix 1 and low 1: Copy
 * World turned each canvas into an "Unnamed" element with a random id).
 */
import "./support/obsidian-shim"; // MUST stay first
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { DrawRelationshipsCommand } from "../Commands/DrawRelationshipsCommand";
import { writeWorldBasesFile } from "../vault/bases-writer";

const W = "OnlyWorlds/Worlds/W";
const IDS = {
	Akragas: "019a0000-0000-7000-8000-0000000000c1",
	Gela: "019a0000-0000-7000-8000-0000000000c2",
	Syracuse: "019a0000-0000-7000-8000-0000000000c3",
};
const note = (id: string, name: string, extra = "") => `---\nname: ${name}\nid: ${id}\n${extra}---\n\n### Description\n\nA city.\n`;

/** Three Location notes, the world's base, a drawn canvas and a user's copy canvas. */
async function seedWorldWithCanvases() {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n- **API Key:** ow_k_test\n");
	await vault.seed(`${W}/Elements/Location/Akragas.md`, note(IDS.Akragas, "Akragas", `neighbours:\n  - "[[Gela]]"\n`));
	await vault.seed(`${W}/Elements/Location/Gela.md`, note(IDS.Gela, "Gela"));
	await vault.seed(`${W}/Elements/Location/Syracuse.md`, note(IDS.Syracuse, "Syracuse"));
	await writeWorldBasesFile(app, "W");
	(app.workspace as unknown as { getActiveFile: () => unknown }).getActiveFile = () =>
		vault.files.get(`${W}/Elements/Location/Akragas.md`)!.file;
	await new DrawRelationshipsCommand(app, () => true).execute();
	await vault.seed(`${W}/Elements/Location/Akragas — relationships (your copy).canvas`, '{"nodes":[],"edges":[]}');
	assert.equal([...vault.files.keys()].filter((p) => p.endsWith(".canvas")).length, 2);
	return { app, vault };
}

function ids(entries: Record<string, unknown>[]): string[] {
	return entries.map((e) => String(e.id)).sort();
}

test("Kael's probe: Copy World takes the 3 notes as 3 elements, never a canvas as an Unnamed one", async () => {
	const { app } = await seedWorldWithCanvases();
	const data = (await new CopyWorldCommand(app as App, {} as never, new WorldService(app)).collectWorldData(W)) as Record<
		string,
		Record<string, unknown>[]
	>;
	assert.deepEqual(ids(data.Location), Object.values(IDS).sort());
	assert.equal(data.Location.some((e) => e.name === "Unnamed"), false);
});

test("Upload World's collect takes the 3 notes as 3 elements", async () => {
	const { app } = await seedWorldWithCanvases();
	const cmd = new ExportWorldCommand(app, {} as never, new WorldService(app), { settings: {} } as never);
	const data = (await cmd.collectWorldData("W")) as Record<string, Record<string, unknown>[]>;
	assert.deepEqual(ids(data.Location), Object.values(IDS).sort());
});
