/**
 * Round C fix round, item 8 (Kael's delta read, note 10 / E-8a; P10b in his
 * c-read): Save Element and auto-sync sent a raw id of an element deleted
 * on onlyworlds.com that has no note here (`birthplace: <GONE>`), and keel
 * refuses the whole save over it. Now, as Upload World does: the id is left
 * out of that save, the note keeps it, the notice names it.
 *
 * The deleted list the plugin keeps used to drop every id with no note here,
 * so a raw id deleted before the last Download was forgotten. It now also
 * keeps an id a note of this world links to, so auto-sync, which reads only
 * the stored list, still knows it.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { harnessSave, HARNESS_WID } from "./support/save-harness";
import { harnessUpload, UPLOAD_WID } from "./support/upload-harness";

const ID = "0199c000-0000-7000-8000-0000000000d1";
const GONE = "0199c000-0000-7000-8000-0000000000d9";
const note = `---\nname: Ireena\nid: ${ID}\nbirthplace: ${GONE}\n---\n\n### Description\n\nA noble.\n`;
const server = { [ID]: { name: "Ireena", description: "A noble." } };

test("★ Save Element leaves out a raw id the feed reports deleted, with no note here, and names it", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "Old." } },
		cursor: { cursor: "c0", head: 0 },
		feed: [{ id: GONE, op: "delete" }],
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent.length, 1);
	assert.equal("birthplace" in r.sent[0], false, `sent ${JSON.stringify(r.sent[0])}`);
	assert.ok(r.notices.some((n) => n.includes(GONE) && /deleted on onlyworlds\.com/.test(n)), r.notices.join(" | "));
	assert.ok((await r.vault.read(r.files["Character/Ireena.md"] as never)).includes(`birthplace: ${GONE}`), "the note lost it");
});

test("★ a save whose only change is that link sends nothing and says so", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note },
		save: "Character/Ireena.md",
		server,
		cursor: { cursor: "c0", head: 0 },
		feed: [{ id: GONE, op: "delete" }],
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, []);
	assert.ok(r.notices.some((n) => n.includes(GONE)), r.notices.join(" | "));
});

test("★ auto-sync leaves it out by the stored list alone, and names it", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "Old." } },
		cursor: { cursor: "c0", head: 0 },
		deleted: [GONE],
		manual: false,
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal("birthplace" in (r.sent[0] ?? {}), false, `sent ${JSON.stringify(r.sent)}`);
	assert.ok(r.notices.some((n) => n.includes(GONE)), r.notices.join(" | "));
	assert.ok(!r.calls.some((c) => c.startsWith("changes")), "auto-sync read the feed");
});

test("★ auto-sync creating a new note leaves out a raw id the list marks deleted, and names it (Kael's fixes read, low 4)", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note },
		save: "Character/Ireena.md",
		cursor: { cursor: "c0", head: 0 },
		deleted: [GONE],
		manual: false,
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.ok(r.calls.includes("create character"), r.calls.join(", "));
	assert.equal("birthplace" in (r.sent[0] ?? {}), false, `sent ${JSON.stringify(r.sent)}`);
	assert.ok(r.notices.some((n) => n.includes(GONE) && /deleted on onlyworlds\.com/.test(n)), r.notices.join(" | "));
});

test("★ Download keeps a deleted id in the list while a note here links it, though it has no note", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Barovia/World.md", "# World Overview: Barovia\n\n- **API Key:** ow_k_test\n");
	await vault.seed("OnlyWorlds/Worlds/Barovia/Elements/Character/Ireena.md", note);
	const plugin = {
		settings: { syncCursors: {} as Record<string, unknown>, deletedOnServer: {} as Record<string, string[]> },
		saveSettings: async () => {},
	};
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: HARNESS_WID, name: "Barovia", description: "" } };
		if (path === "/changes")
			return {
				status: 200,
				json: {
					cursor: "c9",
					has_more: false,
					head: 9,
					changes: [
						{ op: "upsert", type: "location", id: GONE, change_seq: 1, updated_at: "x", element: { id: GONE, name: "Gone" } },
						{ op: "delete", type: "location", id: GONE, change_seq: 2, updated_at: "x" },
					],
				},
			};
		return { status: 404, json: {} };
	});
	await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
	assert.deepEqual(plugin.settings.deletedOnServer[HARNESS_WID], [GONE]);
});

test("Upload World keeps it in the list too", async () => {
	const r = await harnessUpload({
		notes: { "Character/Ireena.md": note },
		changes: [
			{ op: "upsert", type: "character", id: ID, change_seq: 1 },
			{ op: "delete", type: "location", id: GONE, change_seq: 2 },
		],
	});
	assert.deepEqual(r.settings.deletedOnServer[UPLOAD_WID], [GONE]);
});
