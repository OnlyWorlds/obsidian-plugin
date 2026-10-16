/**
 * A link to one of two same-name notes names THAT note — run against the REAL
 * DownloadWorldCommand note writer and the real upload collector through an
 * in-memory vault (test/support/obsidian-mock.ts; its link resolver is a
 * basename emulation of Obsidian's).
 *
 * ★ Row 2 of the data-paths ranking (OW Infra #166, hop 9 #9): download wrote
 * `[[Twin]]` for both twins although the second one's note is `Twin (1).md`,
 * so on upload the second twin's link became the first twin's id.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";

const ELEMENTS = "OnlyWorlds/Worlds/W/Elements";
const T1 = "019a0000-0000-7000-8000-0000000000e1";
const T2 = "019a0000-0000-7000-8000-0000000000e2";
const H = "019a0000-0000-7000-8000-0000000000e3";

async function downloadThenCollect(data: Record<string, unknown[]>) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	await new DownloadWorldCommand(app, {}).generateElementNotes(ELEMENTS, data, false);
	const collected = (await new ExportWorldCommand(app, {} as never, new WorldService(app)).collectWorldData("W")) as Record<
		string,
		Record<string, unknown>[]
	>;
	const byId = new Map<string, Record<string, unknown>>();
	for (const [k, list] of Object.entries(collected)) {
		if (k === "World" || !Array.isArray(list)) continue;
		for (const el of list) byId.set(String(el.id), el);
	}
	return { vault, byId };
}

test("★ two same-name twins download and re-upload with every link id unchanged (row 2)", async () => {
	const { vault, byId } = await downloadThenCollect({
		Character: [
			{ id: T1, name: "Twin", description: "The elder." },
			{ id: T2, name: "Twin", description: "The younger." },
			{ id: H, name: "Holder", friends: [T1, T2], rivals: [T2] },
		],
	});
	// The second twin lives at `Twin (1).md`; its link must say so.
	const holder = vault.contentAt(`${ELEMENTS}/Character/Holder.md`) ?? "";
	assert.match(holder, /\[\[Twin \(1\)\]\]/, holder);
	assert.deepEqual(byId.get(H)?.friends, [T1, T2]);
	assert.deepEqual(byId.get(H)?.rivals, [T2]);
});

test("a twin downloaded later links to the twin note already in the vault", async () => {
	// First pull: only the elder twin exists. Second pull: the younger arrives
	// with a holder that links to both.
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	const dl = new DownloadWorldCommand(app, {});
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: T1, name: "Twin" }] }, false);
	await dl.generateElementNotes(
		ELEMENTS,
		{ Character: [{ id: T2, name: "Twin" }, { id: H, name: "Holder", friends: [T2, T1] }] },
		false
	);
	const holder = vault.contentAt(`${ELEMENTS}/Character/Holder.md`) ?? "";
	assert.match(holder, /- "\[\[Twin \(1\)\]\]"\n\s+- "\[\[Twin\]\]"/, holder);
});
