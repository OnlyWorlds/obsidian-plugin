/**
 * A save that changes an element's name renames its note to match (Seethe's
 * walk of rc-next, finding 4, h37 #6503): the server took the new name and the
 * file kept the old one, so the two drifted further with every edit.
 *
 * The rename goes through Obsidian's fileManager.renameFile, so the user's
 * own "update internal links" setting applies; a name another note already
 * holds gets the twin suffix Download uses (`Name (1)`); a setting turns it
 * off. Run against the REAL SaveElementCommand through the in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __notices } from "./support/obsidian-mock";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { V2ApiError } from "../client-v2";

const DIR = "OnlyWorlds/Worlds/W/Elements/Location";
const ID = "019c0000-0000-7000-8000-0000000000a1";
const OTHER = "019c0000-0000-7000-8000-0000000000a2";
const note = (id: string, name: string) => `---\nname: ${JSON.stringify(name)}\nid: ${id}\n---\n\n### Description\n\nA town.\n`;

async function save(
	fileName: string,
	noteName: string,
	opts: { serverName?: string; setting?: boolean; others?: Record<string, string>; updateError?: Error; manual?: boolean } = {}
) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	for (const [leaf, content] of Object.entries(opts.others ?? {})) await vault.seed(`${DIR}/${leaf}`, content);
	const file = (await vault.seed(`${DIR}/${fileName}`, note(ID, noteName))) as unknown as TFile;
	const client = {
		get: async (_t: string, id: string) => {
			if (id === ID) return { id, name: opts.serverName ?? "Vallaki" };
			throw new V2ApiError(404, "not_found", "API Error 404", null);
		},
		update: async () => {
			if (opts.updateError) throw opts.updateError;
			return {};
		},
		create: async (_t: string, b: Record<string, unknown>) => b,
	};
	const settings: Record<string, unknown> = { apiKey: "" };
	if (opts.setting !== undefined) settings.renameNoteOnNameChange = opts.setting;
	const plugin = { settings, buildV2Client: async () => client };
	__notices.length = 0;
	const result = await new SaveElementCommand(app as App, plugin as never).execute(file, { manual: opts.manual ?? true });
	return { result, renames: (app as unknown as { renames: string[] }).renames, notices: [...__notices] };
}

test("★ Seethe 4: a save whose name changed renames the note, through fileManager.renameFile, and says so", async () => {
	const r = await save("Vallaki.md", "Vallaki Town");
	assert.deepEqual(r.result, { ok: true, outcome: "updated" });
	assert.deepEqual(r.renames, [`${DIR}/Vallaki.md -> ${DIR}/Vallaki Town.md`]);
	assert.ok(r.notices.some((n) => /renamed to "Vallaki Town"/.test(n)), r.notices.join(" | "));
});

test("★ Seethe 4: a name another note holds gets the twin suffix Download uses", async () => {
	const r = await save("Vallaki.md", "Krezk", { others: { "Krezk.md": note(OTHER, "Krezk") } });
	assert.deepEqual(r.renames, [`${DIR}/Vallaki.md -> ${DIR}/Krezk (1).md`]);
});

test("★ auto-sync never renames: a name typed with pauses is saved, the file keeps its name (Kael's read, 7)", async () => {
	const r = await save("Vallaki.md", "Vallaki Town", { manual: false });
	assert.deepEqual(r.result, { ok: true, outcome: "updated" });
	assert.deepEqual(r.renames, []);
});

test("Seethe 4: the setting off leaves the note's name alone", async () => {
	const r = await save("Vallaki.md", "Vallaki Town", { setting: false });
	assert.equal(r.result.ok, true);
	assert.deepEqual(r.renames, []);
});

test("Seethe 4: no rename when the name did not change, when the file already carries it, or when the save failed", async () => {
	assert.deepEqual((await save("Vallaki.md", "Vallaki")).renames, [], "name unchanged");
	// The user renamed the file; Obsidian's listener set `name`: the save sends the name, the file is already right.
	assert.deepEqual((await save("Vallaki Town.md", "Vallaki Town")).renames, [], "file already carries the name");
	assert.deepEqual((await save("Vallaki Town (1).md", "Vallaki Town")).renames, [], "a twin's suffixed name is its name");
	const failed = await save("Vallaki.md", "Vallaki Town", { updateError: new V2ApiError(422, "invalid", "nope", null) });
	assert.equal(failed.result.ok, false);
	assert.deepEqual(failed.renames, [], "a refused save renames nothing");
});

test("Seethe 4: a name with characters a file name cannot hold renames to its safe form", async () => {
	const r = await save("Vallaki.md", "Vallaki: Old Town");
	assert.deepEqual(r.renames, [`${DIR}/Vallaki.md -> ${DIR}/Vallaki- Old Town.md`]);
});
