/**
 * OW Infra #426 through the real commands over the in-memory vault: Download
 * stubs a hidden element's note and counts it apart, writes it in full again
 * on an unhide, reads the 409's reason (view stubs what the fresh walk does
 * not name, role keeps every note); Save Element and Upload World never send
 * a hidden id or a stub.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { HIDDEN_NOT_SAVED, HIDDEN_STUB_LINE, LEFT_VIEW_NOT_SAVED } from "../sync/hidden-on-server";
import { harnessSave, HARNESS_WID } from "./support/save-harness";
import { harnessUpload, UPLOAD_WID } from "./support/upload-harness";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const ZEL = "019e0000-0000-7000-8000-0000000000c1";
const IRE = "019e0000-0000-7000-8000-0000000000c2";
const MINE = "019e0000-0000-7000-8000-0000000000c3";

type Settings = {
	syncCursors: Record<string, unknown>;
	deletedOnServer?: Record<string, string[]>;
	hiddenOnServer?: Record<string, string[]>;
	knownOnServer?: Record<string, string[]>;
	leftView?: Record<string, string[]>;
};

const upsert = (id: string, name: string, seq: number, extra: Record<string, unknown> = {}) => ({
	op: "upsert", type: "character", id, change_seq: seq, updated_at: "x", element: { id, name, ...extra },
});
const hidden = (id: string, seq: number) => ({ op: "delete", type: "character", id, change_seq: seq, updated_at: "x", reason: "hidden" });
const deleted = (id: string, seq: number) => ({ op: "delete", type: "character", id, change_seq: seq, updated_at: "x", reason: "deleted" });

/**
 * One Download. `conflict`: the stored cursor is answered with this 409 body
 * (keel's resync_required), and the walk from the start with `changes`.
 */
async function download(app: App, plugin: { settings: Settings; saveSettings(): Promise<void> }, changes: unknown[], head: number, conflict?: unknown) {
	setRequestUrl((r) => {
		const url = new URL(r.url);
		const path = url.pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") {
			if (conflict && url.searchParams.get("since")) return { status: 409, json: conflict };
			return { status: 200, json: { cursor: `c${head}`, has_more: false, head, changes } };
		}
		return { status: 404, json: {} };
	});
	__notices.length = 0;
	await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
	return [...__notices];
}

function noteOf(app: App, id: string): TFile {
	const vault = app.vault as unknown as { getMarkdownFiles(): TFile[]; files: Map<string, { content: string }> };
	for (const f of vault.getMarkdownFiles()) {
		if (vault.files.get(f.path)?.content.includes(`id: ${id}`)) return f;
	}
	throw new Error(`no note for ${id}`);
}

async function setup() {
	const { app, vault: mock } = makeApp();
	const vault = app.vault;
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	await download(app, plugin, [
		upsert(ZEL, "Zelraun", 1, { description: "A knight of Barovia.", background: "Born in Krezk." }),
		upsert(IRE, "Ireena", 2, { description: "A noble." }),
	], 2);
	const zel = noteOf(app, ZEL);
	// The person writes their own lines above the fields, in this vault only.
	const before = await vault.read(zel);
	const at = before.indexOf("### Description");
	await vault.modify(zel, `${before.slice(0, at)}My table's notes on him.\n\n${before.slice(at)}`);
	return { app, vault, mock, plugin, zel };
}

test("★ Download: a hidden row stubs the note, keeps the person's writing, counts it apart from deletes, and lists the id", async () => {
	const { app, vault, plugin, zel } = await setup();
	const notices = await download(app, plugin, [hidden(ZEL, 3)], 3);
	const after = await vault.read(zel);
	assert.ok(after.includes("My table's notes on him.\n\n"), "the person's writing was lost");
	assert.ok(after.includes(HIDDEN_STUB_LINE));
	assert.ok(!after.includes("A knight") && !after.includes("Krezk") && !after.includes("name: Zelraun"), after);
	assert.ok(notices.includes("1 element was hidden by the world's owner; its fields were emptied from your note."), notices.join(" | "));
	assert.ok(!notices.some((n) => n.includes("deleted on the server")), "the hidden note was counted as a delete");
	assert.deepEqual(plugin.settings.hiddenOnServer?.[WID], [ZEL]);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], []);
	// A second hidden row (a cold re-walk) changes nothing and says nothing.
	plugin.settings.syncCursors = {};
	const again = await download(app, plugin, [upsert(IRE, "Ireena", 2), hidden(ZEL, 3)], 3);
	assert.equal(await vault.read(zel), after);
	assert.ok(!again.some((n) => n.includes("hidden by the world's owner")));
});

test("★ Download: an unhide takes the id off the list and writes the note in full again", async () => {
	const { app, vault, plugin, zel } = await setup();
	await download(app, plugin, [hidden(ZEL, 3)], 3);
	await download(app, plugin, [upsert(ZEL, "Zelraun", 4, { description: "A knight of Barovia." })], 4);
	assert.deepEqual(plugin.settings.hiddenOnServer?.[WID], []);
	const after = await vault.read(noteOf(app, ZEL));
	assert.ok(after.includes("name: Zelraun") && after.includes("A knight of Barovia."));
	assert.ok(!after.includes(HIDDEN_STUB_LINE));
	void zel;
});

test("a plain delete row keeps today's path: the note kept whole, counted as a delete", async () => {
	const { app, vault, plugin, zel } = await setup();
	const before = await vault.read(zel);
	const notices = await download(app, plugin, [deleted(ZEL, 3)], 3);
	assert.equal(await vault.read(zel), before);
	assert.ok(notices.some((n) => n.startsWith("1 element deleted on the server")));
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [ZEL]);
	assert.deepEqual(plugin.settings.hiddenOnServer?.[WID], []);
});

async function resyncSetup() {
	const s = await setup();
	// A note made here and never saved (an element id, not on the server),
	// and the person's own note with no element id.
	const folder = s.zel.parent?.path ?? "";
	const mineNote = `---\nname: Strahd's diary\nid: ${MINE}\n---\n\n### Description\n\nNot uploaded yet.\n`;
	const own = `---\ntags:\n  - mine\n---\n\nMy own note.\n`;
	const mine = (await s.mock.seed(`${folder}/Strahd's diary.md`, mineNote)) as unknown as TFile;
	const ownFile = (await s.mock.seed(`${folder}/Session 3.md`, own)) as unknown as TFile;
	return { ...s, mine, mineNote, ownFile, own };
}

test("★ Download: a 409 with reason view stubs exactly the element notes the fresh walk does not name", async () => {
	const s = await resyncSetup();
	const notices = await download(s.app, s.plugin, [upsert(IRE, "Ireena", 5)], 5, {
		error: { code: "resync_required", message: "Your view of this world changed.", reason: "view" },
	});
	const zel = await s.vault.read(s.zel);
	assert.ok(zel.includes(HIDDEN_STUB_LINE) && zel.includes("My table's notes on him.") && !zel.includes("A knight"), zel);
	assert.equal(await s.vault.read(s.mine), s.mineNote, "a note never on the server was stubbed");
	assert.equal(await s.vault.read(s.ownFile), s.own, "a note with no element id was touched");
	assert.ok(notices.includes("1 element left your view; its fields were emptied from your note."), notices.join(" | "));
	assert.deepEqual(s.plugin.settings.hiddenOnServer?.[WID], [ZEL]);
});

test("★ Download: a 409 with reason role, or with none, keeps every note (the reason read beside the envelope too)", async () => {
	for (const conflict of [
		{ error: { code: "resync_required", message: "m" }, reason: "role" },
		{ error: { code: "resync_required", message: "m" } },
	]) {
		const s = await resyncSetup();
		const before = await s.vault.read(s.zel);
		const notices = await download(s.app, s.plugin, [upsert(IRE, "Ireena", 5)], 5, conflict);
		assert.equal(await s.vault.read(s.zel), before);
		assert.equal(await s.vault.read(s.mine), s.mineNote);
		assert.ok(!notices.some((n) => n.includes("your view") || n.includes("hidden")), notices.join(" | "));
		assert.deepEqual(s.plugin.settings.hiddenOnServer?.[WID] ?? [], []);
	}
});

test("Download: a view 409 with the reason beside the envelope stubs too", async () => {
	const s = await resyncSetup();
	await download(s.app, s.plugin, [upsert(IRE, "Ireena", 5)], 5, { error: { code: "resync_required", message: "m" }, reason: "view" });
	assert.ok((await s.vault.read(s.zel)).includes(HIDDEN_STUB_LINE));
});

const stub = (id: string) => `---\nname:\nid: ${id}\n---\n\nMine.\n\n${HIDDEN_STUB_LINE}\n`;
const plain = (id: string, name: string, links = "") => `---\nname: ${name}\nid: ${id}\n${links}---\n\n### Description\n\nAbout ${name}.\n`;

test("★ Save Element on a stub refuses, sends nothing, says why", async () => {
	for (const manual of [true, false]) {
		const r = await harnessSave({ notes: { "Character/Zelraun.md": stub(ZEL) }, save: "Character/Zelraun.md", manual });
		assert.deepEqual(r.result, { ok: false, reason: HIDDEN_NOT_SAVED });
		assert.deepEqual(r.calls, []);
		assert.deepEqual(r.sent, []);
	}
});

test("★ Save Element of an id on the hidden list refuses, even before its note is a stub", async () => {
	const r = await harnessSave({ notes: { "Character/Zelraun.md": plain(ZEL, "Zelraun") }, save: "Character/Zelraun.md", hidden: [ZEL] });
	assert.deepEqual(r.result, { ok: false, reason: HIDDEN_NOT_SAVED });
	assert.deepEqual(r.sent, []);
	assert.ok(r.notices.includes(HIDDEN_NOT_SAVED));
});

test("Save Element of a note whose 404 the feed explains as hidden refuses, never offers to create it", async () => {
	const r = await harnessSave({
		notes: { "Character/Zelraun.md": plain(ZEL, "Zelraun") },
		save: "Character/Zelraun.md",
		cursor: { cursor: "c1", head: 1 },
		feed: [{ id: ZEL, op: "delete", reason: "hidden" } as { id: string; op: string }],
	});
	assert.deepEqual(r.result, { ok: false, reason: HIDDEN_NOT_SAVED });
	assert.deepEqual(r.sent, []);
});

test("★ Save Element never creates a hidden link target: the link is left out and named as hidden", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": plain(IRE, "Ireena", `friends:\n  - "[[Zelraun]]"\n`),
			"Character/Zelraun.md": stub(ZEL),
		},
		save: "Character/Ireena.md",
		server: { [IRE]: { name: "Ireena", description: "About Ireena.", friends: [] } },
		hidden: [ZEL],
	});
	assert.equal(r.result.ok, true);
	assert.ok(!r.calls.includes("bulk"), "the stub was created first");
	assert.ok(!JSON.stringify(r.sent).includes(ZEL), "the hidden id was sent");
	assert.ok(r.notices.some((n) => n.includes("hidden by the world's owner")), r.notices.join(" | "));
});

test("★ Upload World never sends a stub or a hidden id, and strips links to it", async () => {
	const NEW = "019a0000-0000-7000-8000-0000000000c9";
	const r = await harnessUpload({
		notes: {
			"Character/Zelraun.md": stub(ZEL),
			"Character/Ireena.md": plain(IRE, "Ireena", `friends:\n  - "[[Zelraun]]"\n`),
			"Character/Kasimir.md": plain(NEW, "Kasimir"),
		},
		changes: [upsert(IRE, "Ireena", 1), upsert(NEW, "Kasimir", 2), upsert(ZEL, "Zelraun", 3), hidden(ZEL, 4), { ...hidden(NEW, 5) }],
		hidden: [ZEL],
		answer: true,
	});
	assert.ok(!JSON.stringify(r.bulkSent).includes(ZEL) && !JSON.stringify(r.patches).includes(ZEL), "a hidden id was sent");
	assert.ok(!JSON.stringify(r.bulkSent).includes(NEW), "a hidden row's note was offered again and sent");
	assert.ok(!(ZEL in r.patches) && !(NEW in r.patches));
	assert.ok(r.notices.some((n) => n.includes("hidden by the world's owner")), r.notices.join(" | "));
	assert.deepEqual(r.settings.deletedOnServer[UPLOAD_WID], [], "a hidden id went on the deleted list");
	void HARNESS_WID;
});

// --- Kael's read of the branch (h37 #8212), ruled -----------------------------

test("★ Download: an unhide carries the stub's kept writing into the new body, below the fields, byte for byte", async () => {
	const { app, vault, plugin } = await setup();
	await download(app, plugin, [hidden(ZEL, 3)], 3);
	const stubbed = noteOf(app, ZEL);
	await vault.modify(stubbed, `${await vault.read(stubbed)}\nA line I wrote in the stub.\n`);
	await download(app, plugin, [upsert(ZEL, "Zelraun", 4, { description: "A knight of Barovia." })], 4);
	const after = await vault.read(noteOf(app, ZEL));
	assert.ok(after.includes("name: Zelraun") && after.includes("A knight of Barovia."), after);
	assert.ok(!after.includes(HIDDEN_STUB_LINE), after);
	assert.ok(after.includes("My table's notes on him.\n\nA line I wrote in the stub.\n"), after);
	assert.ok(after.indexOf("A line I wrote") > after.indexOf("### Description"), "the kept writing is not below the fields");
});

test("★ an upgraded install (a cursor, no knownOnServer) walks the feed from the start once to fill the list, and applies nothing else from it", async () => {
	const { app, vault, plugin, zel } = await setup();
	delete plugin.settings.knownOnServer;
	const before = await vault.read(zel);
	const sinces: (string | null)[] = [];
	setRequestUrl((r) => {
		const url = new URL(r.url);
		const path = url.pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") {
			const since = url.searchParams.get("since");
			sinces.push(since);
			const changes = since
				? [upsert(IRE, "Ireena", 3, { description: "Changed." })]
				: [upsert(ZEL, "Zelraun the Renamed", 1, { description: "From the full walk." }), upsert(IRE, "Ireena", 3)];
			return { status: 200, json: { cursor: "c3", has_more: false, head: 3, changes } };
		}
		return { status: 404, json: {} };
	});
	await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
	assert.ok(sinces.includes(null) && sinces.includes("c2"), `walks: ${sinces.join(",")}`);
	assert.deepEqual([...(plugin.settings.knownOnServer?.[WID] ?? [])].sort(), [ZEL, IRE].sort());
	assert.equal(await vault.read(zel), before, "the fill walk's changes were applied");
	// Filled once: the next Download walks only from its cursor.
	sinces.length = 0;
	await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
	assert.deepEqual(sinces, ["c3"]);
});

test("★ a role reset puts a kept note's id on leftView (never a note made here); saving the kept note sends no create", async () => {
	const s = await resyncSetup();
	await download(s.app, s.plugin, [upsert(IRE, "Ireena", 5)], 5, { error: { code: "resync_required", message: "m", reason: "role" } });
	assert.deepEqual(s.plugin.settings.leftView?.[WID], [ZEL]);
	for (const manual of [true, false]) {
		const r = await harnessSave({ notes: { "Character/Zelraun.md": plain(ZEL, "Zelraun, edited") }, save: "Character/Zelraun.md", leftView: [ZEL], manual });
		assert.deepEqual(r.result, { ok: false, reason: LEFT_VIEW_NOT_SAVED });
		assert.ok(!r.calls.some((c) => c.startsWith("create") || c === "bulk"), r.calls.join(","));
		assert.deepEqual(r.sent, []);
	}
});

test("★ the create-first walk never creates a left-view target: the link is left out and named so", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": plain(IRE, "Ireena", `friends:\n  - "[[Zelraun]]"\n`),
			"Character/Zelraun.md": plain(ZEL, "Zelraun"),
		},
		save: "Character/Ireena.md",
		server: { [IRE]: { name: "Ireena", description: "About Ireena.", friends: [] } },
		leftView: [ZEL],
	});
	assert.ok(!r.calls.includes("bulk"), "the left-view note was created first");
	assert.ok(!JSON.stringify(r.sent).includes(ZEL));
	assert.ok(r.notices.some((n) => n.includes("no longer in your view")), r.notices.join(" | "));
});

test("★ Upload World never sends a left-view note, and strips links to it; an upsert in its walk lifts that", async () => {
	const r = await harnessUpload({
		notes: {
			"Character/Zelraun.md": plain(ZEL, "Zelraun"),
			"Character/Ireena.md": plain(IRE, "Ireena", `friends:\n  - "[[Zelraun]]"\n`),
		},
		changes: [upsert(IRE, "Ireena", 1)],
		leftView: [ZEL],
		answer: true,
	});
	assert.ok(!JSON.stringify(r.bulkSent).includes(ZEL) && !JSON.stringify(r.patches).includes(ZEL), "a left-view id was sent");
	assert.ok(r.notices.some((n) => n.includes("no longer in your view")), r.notices.join(" | "));
	const back = await harnessUpload({ notes: { "Character/Zelraun.md": plain(ZEL, "Zelraun") }, changes: [upsert(ZEL, "Zelraun", 1)], leftView: [ZEL] });
	assert.ok(ZEL in back.patches, "an id the walk names again was not sent");
});
