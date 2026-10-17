/**
 * Round C fix round, item 6 (N7 from Kael's fixes read): auto-sync sends a
 * new name first, so by the time the user runs Save Element the server
 * already holds it, the name is not in the diff, and Save never renamed the
 * file. Auto-sync still never renames (a rename while typing moves the file
 * under the user). Now auto-sync records the pending rename for the note and
 * says so; the next Save Element on the note renames it, even when nothing
 * else changed.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __notices } from "./support/obsidian-mock";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { V2ApiError } from "../client-v2";

const DIR = "OnlyWorlds/Worlds/W/Elements/Location";
const ID = "019c0000-0000-7000-8000-0000000000c1";
const note = (name: string, text = "A town.") => `---\nname: ${JSON.stringify(name)}\nid: ${ID}\n---\n\n### Description\n\n${text}\n`;

async function session(settings: Record<string, unknown> = { apiKey: "" }, id = ID, serverName = "Vallaki") {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	const file = (await vault.seed(`${DIR}/Vallaki.md`, note("Vallaki Town").replace(ID, id))) as unknown as TFile;
	const serverEl: Record<string, unknown> = { id, name: serverName, description: "A town." };
	const sent: Record<string, unknown>[] = [];
	const client = {
		get: async (_t: string, asked: string) => {
			if (asked === id) return { ...serverEl };
			throw new V2ApiError(404, "not_found", "API Error 404", null);
		},
		update: async (_t: string, _id: string, b: Record<string, unknown>) => {
			sent.push(b);
			Object.assign(serverEl, b);
			return {};
		},
		create: async (_t: string, b: Record<string, unknown>) => b,
		getWorld: async () => ({ id: "019e0000-0000-7000-8000-0000000000ee" }),
	};
	let saves = 0;
	const plugin = { settings, saveSettings: async () => void saves++, buildV2Client: async () => client };
	const cmd = new SaveElementCommand(app as App, plugin as never);
	const run = async (manual: boolean) => {
		__notices.length = 0;
		const result = await cmd.execute(file, { manual });
		return { result, notices: [...__notices] };
	};
	return { app, vault, file, sent, run, settings, saves: () => saves, renames: () => (app as unknown as { renames: string[] }).renames };
}

test("★ auto-sync saves a new name, keeps the note's file name, and says Save Element renames it", async () => {
	const s = await session();
	const r = await s.run(false);
	assert.deepEqual(r.result, { ok: true, outcome: "updated" });
	assert.equal(s.sent[0]?.name, "Vallaki Town");
	assert.deepEqual(s.renames(), []);
	assert.ok(
		r.notices.some((n) => /The note keeps its old name; Save Element renames it\./.test(n)),
		r.notices.join(" | ")
	);
});

test("★ the next Save Element renames the note though nothing else changed", async () => {
	const s = await session();
	await s.run(false);
	const r = await s.run(true);
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(s.renames(), [`${DIR}/Vallaki.md -> ${DIR}/Vallaki Town.md`]);
	assert.ok(r.notices.some((n) => /renamed to "Vallaki Town"/.test(n)), r.notices.join(" | "));
	assert.equal(s.sent.length, 1, "the manual Save sent something");
});

test("★ the pending rename is kept in the plugin's data, per world and note id (Kael's fixes read, low 5)", async () => {
	const s = await session();
	await s.run(false);
	assert.deepEqual((s.settings as { pendingRenames?: unknown }).pendingRenames, { W: [ID] });
	assert.ok(s.saves() > 0, "the plugin's data was not saved");
	await s.run(true);
	assert.deepEqual((s.settings as { pendingRenames?: unknown }).pendingRenames, { W: [] });
});

test("★ after a restart (the pending rename read back from the plugin's data), the next Save renames", async () => {
	const AFTER = "019c0000-0000-7000-8000-0000000000c9";
	// The server already holds the new name: auto-sync sent it before the restart.
	const s = await session({ apiKey: "", pendingRenames: { W: [AFTER] } }, AFTER, "Vallaki Town");
	const r = await s.run(true);
	assert.deepEqual(s.sent, [], "something was sent");
	assert.deepEqual(s.renames(), [`${DIR}/Vallaki.md -> ${DIR}/Vallaki Town.md`], r.notices.join(" | "));
});

test("a second Save after the rename renames nothing more", async () => {
	const s = await session();
	await s.run(false);
	await s.run(true);
	await s.run(true);
	assert.equal(s.renames().length, 1);
});
