/**
 * An element deleted on onlyworlds.com is never recreated by a save (Kael's
 * cold read, blocker 1c, OW Infra #166 row 8). Download keeps a deleted
 * element's note on purpose ("Notes are never auto-deleted"), so a note can
 * still link to it, and a GET answers 404 for "deleted" exactly as for "not
 * pushed yet". Download now keeps the ids the change feed reported deleted,
 * per world, in the plugin's data; the manual Save's create-first walk leaves
 * them out and says so.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setRequestUrl, __notices, __modals } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { V2ApiError } from "../client-v2";
import { readDeletedOnServer } from "../sync/deleted-on-server";

const WID = "019e0000-0000-7000-8000-0000000000ee";
const IREENA = "019e0000-0000-7000-8000-0000000000c1";
const VALLAKI = "019e0000-0000-7000-8000-0000000000a1";
const KREZK = "019e0000-0000-7000-8000-0000000000a2";

type Settings = { syncCursors: Record<string, unknown>; deletedOnServer?: Record<string, string[]> };

async function download(app: App, plugin: { settings: Settings; saveSettings(): Promise<void> }, changes: unknown[], head: number) {
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: `c${head}`, has_more: false, head, changes } };
		return { status: 404, json: {} };
	});
	await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
}

const upsert = (id: string, name: string, seq: number) => ({
	op: "upsert", type: "location", id, change_seq: seq, updated_at: "x", element: { id, name },
});
const del = (id: string, seq: number) => ({ op: "delete", type: "location", id, change_seq: seq, updated_at: "x" });

test("★ Download keeps the ids the change feed reported deleted whose notes it kept, per world; a later upsert clears one", async () => {
	const { app } = makeApp();
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	await download(app, plugin, [upsert(VALLAKI, "Vallaki", 1), upsert(KREZK, "Krezk", 2)], 2);
	await download(app, plugin, [del(VALLAKI, 3)], 3);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [VALLAKI]);
	await download(app, plugin, [upsert(VALLAKI, "Vallaki", 4), del(KREZK, 5)], 5);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [KREZK]);
});

test("★ the list holds only ids with a local note: a delete of an element this vault never had is not kept (Kael's third read, 4)", async () => {
	const { app } = makeApp();
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	// A full first Download sees every delete the world ever had.
	await download(app, plugin, [upsert(KREZK, "Krezk", 1), upsert(VALLAKI, "Vallaki", 2), del(VALLAKI, 3)], 3);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [], "an id with no note was kept");
});

const note = (id: string, name: string, links = "") =>
	`---\nname: ${name}\nid: ${id}\n${links}---\n\n### Description\n\nAbout ${name}.\n`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SaveOpts {
	notes: Record<string, string>;
	/** The note saved (default the Character Ireena). */
	save?: string;
	/** Ids already in the plugin's deleted list. */
	deleted?: string[];
	/** Elements on the server now: id -> its current body. Everything else 404s. */
	server?: Record<string, Record<string, unknown>>;
	/** The stored change-feed cursor for the world (none: never downloaded here). */
	cursor?: string;
	/** What the change feed returns from that cursor. */
	feed?: unknown[];
	/** The change feed read fails (a 503). */
	feedFails?: boolean;
	/** The world read (getWorld) fails, so a recreate cannot learn the world's id. */
	worldReadFails?: boolean;
	/** The feed answers keel's 409 resync_required (a guest's cursor after a delete it could see). */
	feedResync?: boolean;
	/** The head the feed reports (default 99; the stored head is 5). */
	feedHead?: number;
	/** Every dialog is answered with this (default true: Create). */
	answer?: boolean;
	/** The manual Save Element (default), or auto-sync's save. */
	manual?: boolean;
	/** Ids keel answers 410 gone for on a GET (this world deleted them; OW Infra #403). */
	gone?: string[];
}

async function saveNote(o: SaveOpts) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	const files: Record<string, TFile> = {};
	for (const [rel, c] of Object.entries(o.notes)) files[rel] = (await vault.seed(`OnlyWorlds/Worlds/W/Elements/${rel}`, c)) as unknown as TFile;
	const server = new Map(Object.entries(o.server ?? {}));
	const calls: string[] = [];
	const bulks: string[][] = [];
	const sent: Record<string, unknown>[] = [];
	/** keel refuses a write linking an element it does not have (elements/resolve.py InvalidLink). */
	const refuseMissing = (b: Record<string, unknown>) => {
		for (const [k, v] of Object.entries(b)) {
			if (k === "id") continue;
			for (const x of Array.isArray(v) ? v : [v]) {
				if (typeof x === "string" && UUID.test(x) && !server.has(x)) {
					throw new V2ApiError(400, "invalid_link", `${k} references Location '${x}' which does not exist.`, null);
				}
			}
		}
	};
	const client = {
		getWorld: async () => {
			calls.push("world");
			if (o.worldReadFails) throw new V2ApiError(503, "unavailable", "Service Unavailable", null);
			return { id: WID, name: "W" };
		},
		changesWalk: async (since?: string) => {
			calls.push(`changes ${since ?? "epoch"}`);
			if (o.feedFails) throw new V2ApiError(503, "unavailable", "Service Unavailable", null);
			if (o.feedResync) throw new V2ApiError(409, "resync_required", "Resync required", null);
			return { changes: o.feed ?? [], cursor: "c-next", head: o.feedHead ?? 99 };
		},
		get: async (type: string, id: string) => {
			calls.push(`get ${type} ${id}`);
			const el = server.get(id);
			if (el) return { id, ...el };
			if (o.gone?.includes(id)) throw new V2ApiError(410, "gone", "This element was deleted.", null);
			throw new V2ApiError(404, "not_found", "API Error 404", null);
		},
		create: async (type: string, b: Record<string, unknown>) => {
			calls.push(`create ${type} ${String(b.id)}`);
			refuseMissing(b);
			sent.push(b);
			server.set(String(b.id), b);
			return b;
		},
		update: async (type: string, id: string, b: Record<string, unknown>) => {
			calls.push(`update ${type} ${id}`);
			refuseMissing(b);
			sent.push(b);
			return {};
		},
		bulkCreate: async (items: { type: string; element: Record<string, unknown> }[]) => {
			calls.push("bulk");
			bulks.push(items.map((i) => String(i.element.id)));
			// keel: an item's links must exist in the world or among the batch (one pass is enough here).
			const batch = new Set(items.map((i) => String(i.element.id)));
			const results = items.map((i) => {
				for (const [k, v] of Object.entries(i.element)) {
					if (k === "id") continue;
					for (const x of Array.isArray(v) ? v : [v]) {
						if (typeof x === "string" && UUID.test(x) && !server.has(x) && !batch.has(x)) {
							return { status: 400, id: i.element.id, error: { message: `${k} references Location '${x}' which does not exist.` } };
						}
					}
				}
				return { status: 201, id: i.element.id };
			});
			items.forEach((i, n) => {
				if (results[n].status === 201) server.set(String(i.element.id), i.element);
			});
			return { errors: results.some((r) => r.status !== 201), items: results };
		},
	};
	const settings = {
		apiKey: "",
		deletedOnServer: { [WID]: o.deleted ?? [] } as Record<string, string[]>,
		syncCursors: (o.cursor ? { [WID]: { cursor: o.cursor, head: 5 } } : {}) as Record<string, unknown>,
	};
	const plugin = { settings, saveSettings: async () => {}, buildV2Client: async () => client };
	__notices.length = 0;
	__modals.length = 0;
	const dialogs: { items?: unknown[]; leftOut?: unknown[]; cannotTell?: boolean; title?: string; lines?: string[]; choose(b: boolean): void }[] = [];
	let done = false;
	const file = files[o.save ?? "Character/Ireena.md"];
	const run = new SaveElementCommand(app, plugin as never).execute(file, { manual: o.manual ?? true }).finally(() => (done = true));
	while (!done) {
		await new Promise((r) => setImmediate(r));
		for (const m of __modals.splice(0)) {
			const d = m as unknown as (typeof dialogs)[number];
			if (typeof d.choose !== "function") continue;
			dialogs.push(d);
			d.choose(o.answer ?? true);
		}
	}
	// The create-first dialogs alone (a new note on a device that cannot tell also gets its own confirm first).
	const createFirst = dialogs.filter((d) => Array.isArray(d.items));
	return { result: await run, calls, bulks, sent, dialogs, createFirst, settings, notices: [...__notices], vault, file };
}

/** The first round's shape: a manual Save with a deleted list and no feed. */
async function manualSave(deleted: string[], notes: Record<string, string>, answer = true) {
	return saveNote({ deleted, notes, answer });
}

test("★ a target the change feed reported deleted is never recreated; the dialog says it is left out", async () => {
	const r = await manualSave([VALLAKI], {
		"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\nlocation: "[[Krezk]]"\n'),
		"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
		"Location/Krezk.md": note(KREZK, "Krezk"),
	});
	assert.equal(r.createFirst.length, 1);
	assert.deepEqual(r.createFirst[0].items, [{ type: "location", name: "Krezk" }]);
	assert.deepEqual(r.createFirst[0].leftOut, [{ type: "location", name: "Vallaki" }]);
	for (const b of r.bulks) assert.ok(!b.includes(VALLAKI), "a deleted element was recreated");
});

test("★ the only target deleted: no dialog, nothing recreated, the notice names it", async () => {
	const r = await manualSave([VALLAKI], {
		"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
		"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
	});
	assert.equal(r.createFirst.length, 0);
	assert.deepEqual(r.bulks, []);
	assert.ok(
		r.notices.some((n) => n.includes('Location "Vallaki" was deleted on onlyworlds.com: the link is left out of this save, and the note keeps it.')),
		r.notices.join(" | ")
	);
});

// --- Kael's second read, N3: a delete no Download has seen yet ---------------

const IREENA_TO_VALLAKI = {
	"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\nlocation: "[[Krezk]]"\n'),
	"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
	"Location/Krezk.md": note(KREZK, "Krezk"),
};

test("★ the walk's first 404 reads the change feed once from the stored cursor: another member's delete is left out, not offered", async () => {
	const r = await saveNote({ notes: IREENA_TO_VALLAKI, cursor: "c5", feed: [del(VALLAKI, 6)] });
	assert.deepEqual(r.calls.filter((c) => c.startsWith("changes")), ["changes c5"], "the feed was not read once from the cursor");
	assert.equal(r.dialogs.length, 1);
	assert.deepEqual(r.dialogs[0].items, [{ type: "location", name: "Krezk" }]);
	assert.deepEqual(r.dialogs[0].leftOut, [{ type: "location", name: "Vallaki" }]);
	for (const b of r.bulks) assert.ok(!b.includes(VALLAKI), "a deleted element was recreated");
	assert.deepEqual(r.settings.deletedOnServer[WID], [VALLAKI], "the delete was not kept in the list");
	assert.equal(r.settings.syncCursors[WID] && (r.settings.syncCursors[WID] as { cursor: string }).cursor, "c5", "the save moved Download's cursor");
});

test("★ no stored cursor: the feed is read once from the start, and a delete it reports is left out (amended rule 2)", async () => {
	const r = await saveNote({ notes: IREENA_TO_VALLAKI, feed: [del(VALLAKI, 6)] });
	assert.deepEqual(r.calls.filter((c) => c.startsWith("changes")), ["changes epoch"], "not one full read");
	assert.equal(r.createFirst.length, 1);
	assert.deepEqual(r.createFirst[0].leftOut, [{ type: "location", name: "Vallaki" }]);
	assert.equal(r.createFirst[0].cannotTell, false, "a full read can tell");
	assert.deepEqual(r.settings.syncCursors, {}, "the full read was written as a cursor");
});

// --- Kael's second read, N5: a left-out link does not sink the save ---------

const GONE = "019e0000-0000-7000-8000-0000000000b9";
const BRAVE = "019e0000-0000-7000-8000-0000000000b1";

test("★ a link to a deleted element is left out of that save's PATCH, so the note's other edits land; the note keeps the link", async () => {
	const content = note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\ntraits:\n  - "[[Brave]]"\n  - "[[Gone]]"\n').replace("About Ireena.", "A new line.");
	const r = await saveNote({
		notes: {
			"Character/Ireena.md": content,
			"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
			"Trait/Brave.md": note(BRAVE, "Brave"),
			"Trait/Gone.md": note(GONE, "Gone"),
		},
		deleted: [VALLAKI, GONE],
		server: { [IREENA]: { name: "Ireena", description: "About Ireena.", birthplace: null, traits: [BRAVE] }, [BRAVE]: { name: "Brave" } },
	});
	assert.deepEqual(r.result, { ok: true, outcome: "updated" }, JSON.stringify(r.result));
	const patch = r.sent.at(-1)!;
	assert.equal(patch.description, "A new line.");
	assert.equal("birthplace" in patch, false, "the deleted single link was sent");
	assert.equal("traits" in patch, false, "traits equal the server's once Gone is out: nothing to send");
	assert.equal(r.vault.contentAt(r.file.path), content, "the note lost its links");
	assert.ok(r.notices.some((n) => /left out of this save/.test(n) && /Vallaki/.test(n)), r.notices.join(" | "));
});

test("★ a new note linking a deleted element is created without that link", async () => {
	const r = await saveNote({
		notes: { "Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\n'), "Location/Vallaki.md": note(VALLAKI, "Vallaki") },
		deleted: [VALLAKI],
	});
	assert.deepEqual(r.result, { ok: true, outcome: "created" }, JSON.stringify(r.result));
	assert.equal("birthplace" in r.sent.at(-1)!, false);
});

// --- Kael's third read, 3: the strip reaches the walk's own targets ---------

const BAROVIA = "019e0000-0000-7000-8000-0000000000a3";
const DEEP = {
	"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Barovia]]"\n').replace("About Ireena.", "Edited."),
	"Location/Barovia.md": note(BAROVIA, "Barovia", 'parent_location: "[[Vallaki]]"\n'),
	"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
};

test("★ Ireena -> new Barovia -> deleted Vallaki: Barovia goes without the Vallaki link, and Ireena's edit lands", async () => {
	const r = await saveNote({
		notes: DEEP,
		deleted: [VALLAKI],
		server: { [IREENA]: { name: "Ireena", description: "About Ireena.", birthplace: null } },
	});
	assert.deepEqual(r.result, { ok: true, outcome: "updated" }, JSON.stringify(r.result));
	assert.deepEqual(r.createFirst[0]?.leftOut, [{ type: "location", name: "Vallaki" }]);
	assert.deepEqual(r.bulks, [[BAROVIA]]);
	const patch = r.sent.at(-1)!;
	assert.equal(patch.description, "Edited.");
	assert.equal(patch.birthplace, BAROVIA);
});

test("the same with Ireena new too: one /bulk, both created, no Vallaki link", async () => {
	const r = await saveNote({ notes: DEEP, deleted: [VALLAKI] });
	assert.deepEqual(r.result, { ok: true, outcome: "created" }, JSON.stringify(r.result));
	assert.deepEqual(r.bulks, [[BAROVIA, IREENA]]);
});

// --- Kael's third read, 4a: auto-sync and the stored list --------------------

test("★ auto-sync leaves a link to an element in the stored deleted list out of its PATCH, no feed read, and the edit lands", async () => {
	const content = note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\n').replace("About Ireena.", "Edited.");
	const r = await saveNote({
		notes: { "Character/Ireena.md": content, "Location/Vallaki.md": note(VALLAKI, "Vallaki") },
		deleted: [VALLAKI],
		cursor: "c5",
		server: { [IREENA]: { name: "Ireena", description: "About Ireena.", birthplace: null } },
		manual: false,
	});
	assert.deepEqual(r.result, { ok: true, outcome: "updated" }, JSON.stringify(r.result));
	const patch = r.sent.at(-1)!;
	assert.equal(patch.description, "Edited.");
	assert.equal("birthplace" in patch, false);
	assert.deepEqual(r.calls.filter((c) => c.startsWith("changes")), [], "auto-sync read the feed");
	assert.equal(r.vault.contentAt(r.file.path), content, "the note lost its link");
	assert.ok(r.notices.some((n) => /Vallaki/.test(n) && /left out of this save/.test(n)), r.notices.join(" | "));
});

// --- Kael's second read, N1: the deleted element's OWN note -----------------

const VALLAKI_NOTE = { "Location/Vallaki.md": note(VALLAKI, "Vallaki") };

test("★ auto-sync on a deleted element's own note refuses: nothing created, the notice says Save Element can create it again", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", deleted: [VALLAKI], manual: false });
	assert.equal(r.result.ok, false);
	assert.match((r.result as { reason: string }).reason, /Vallaki was deleted on onlyworlds\.com; Save element can create it again/);
	assert.ok(!r.calls.some((c) => c.startsWith("create") || c === "bulk"), r.calls.join(" | "));
});

test("★ auto-sync also refuses when the delete is only in the change feed (no Download since)", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", cursor: "c5", feed: [del(VALLAKI, 6)], manual: false });
	assert.equal(r.result.ok, false);
	assert.ok(!r.calls.some((c) => c.startsWith("create")));
});

test("★ the manual Save asks 'deleted on onlyworlds.com: create it again?'; Cancel creates nothing", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", deleted: [VALLAKI], answer: false });
	assert.equal(r.dialogs.length, 1);
	assert.match(String(r.dialogs[0].title), /deleted on onlyworlds\.com: create it again\?/i);
	assert.equal(r.result.ok, false);
	assert.ok(!r.calls.some((c) => c.startsWith("create")));
});

test("Create again recreates it and takes it off the deleted list", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", deleted: [VALLAKI] });
	assert.deepEqual(r.result, { ok: true, outcome: "created" });
	assert.ok(r.calls.includes(`create location ${VALLAKI}`));
	assert.deepEqual(r.settings.deletedOnServer[WID], []);
});

// --- OW Infra #403: keel answers 410 for an id this world deleted ----------

const feedReads = (calls: string[]) => calls.filter((c) => c.startsWith("changes"));

test("★ 410 on the save's GET, auto-sync: refused with the deleted message, no feed read, nothing created", async () => {
	// The feed says nothing was deleted: only the 410 can tell.
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", cursor: "c5", feed: [], gone: [VALLAKI], manual: false });
	assert.equal(r.result.ok, false);
	assert.match((r.result as { reason: string }).reason, /Vallaki was deleted on onlyworlds\.com; Save element can create it again/);
	assert.deepEqual(feedReads(r.calls), [], "a 410 read the feed");
	assert.ok(!r.calls.some((c) => c.startsWith("create") || c === "bulk"), r.calls.join(" | "));
});

test("★ 410 on the save's GET, manual Save: asks 'create it again?', creates on yes, no feed read", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", cursor: "c5", feed: [], gone: [VALLAKI] });
	assert.equal(r.dialogs.length, 1);
	assert.match(String(r.dialogs[0].title), /deleted on onlyworlds\.com: create it again\?/i);
	assert.deepEqual(r.result, { ok: true, outcome: "created" });
	assert.ok(r.calls.includes(`create location ${VALLAKI}`), r.calls.join(" | "));
	assert.deepEqual(feedReads(r.calls), [], "a 410 read the feed");
});

test("410, manual Save, Cancel creates nothing; Create again takes it off the stored deleted list", async () => {
	const no = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", gone: [VALLAKI], answer: false });
	assert.equal(no.dialogs.length, 1);
	assert.equal(no.result.ok, false);
	assert.ok(!no.calls.some((c) => c.startsWith("create")));
	const yes = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", gone: [VALLAKI], deleted: [VALLAKI] });
	assert.deepEqual(yes.result, { ok: true, outcome: "created" });
	assert.deepEqual(yes.settings.deletedOnServer[WID], []);
});

test("★ 410, Create again, and the world read fails: the id still leaves the stored deleted list (Kael's delta read, low)", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", gone: [VALLAKI], deleted: [VALLAKI], worldReadFails: true });
	assert.deepEqual(r.result, { ok: true, outcome: "created" });
	assert.ok(r.calls.includes("world"), "the world was never read");
	assert.deepEqual(r.settings.deletedOnServer[WID], [], "a recreated id stayed on the deleted list");
});

test("★ 410 on a linked target: left out as a feed-reported delete is, with no feed read; the PATCH goes without the link", async () => {
	const r = await saveNote({
		notes: {
			"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
			"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
		},
		server: { [IREENA]: { name: "Ireena", description: "Old." } },
		cursor: "c5",
		feed: [],
		gone: [VALLAKI],
	});
	assert.deepEqual(feedReads(r.calls), [], "a 410 read the feed");
	assert.equal(r.createFirst.length, 0);
	assert.deepEqual(r.bulks, []);
	assert.ok(!r.calls.includes(`create location ${VALLAKI}`), "a deleted element was recreated");
	assert.ok(r.calls.includes(`update character ${IREENA}`), r.calls.join(" | "));
	assert.equal(r.sent.length, 1);
	assert.equal(r.sent[0].description, "About Ireena.", "the note's other edit did not land");
	assert.equal("birthplace" in r.sent[0], false, "the PATCH carried the deleted link");
	assert.ok(
		r.notices.some((n) => n.includes('Location "Vallaki" was deleted on onlyworlds.com: the link is left out of this save, and the note keeps it.')),
		r.notices.join(" | ")
	);
});

test("410 on one target, 404 on another: the dialog offers the new one and lists the 410 as left out", async () => {
	const r = await saveNote({ notes: IREENA_TO_VALLAKI, cursor: "c5", feed: [], gone: [VALLAKI] });
	assert.equal(r.createFirst.length, 1);
	assert.deepEqual(r.createFirst[0].items, [{ type: "location", name: "Krezk" }]);
	assert.deepEqual(r.createFirst[0].leftOut, [{ type: "location", name: "Vallaki" }]);
	for (const b of r.bulks) assert.ok(!b.includes(VALLAKI), "a deleted element was recreated");
});

test("a never-uploaded note, not in the list, still creates as before with no dialog", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", manual: false });
	assert.deepEqual(r.result, { ok: true, outcome: "created" });
	assert.equal(r.dialogs.length, 0);
});

// --- Kael's third read, 2: a device that cannot tell (four cells) ------------

const OWN = { notes: VALLAKI_NOTE, save: "Location/Vallaki.md" };

test("★ stored cursor, feed read fails, auto-sync: refused this tick, nothing created", async () => {
	const r = await saveNote({ ...OWN, cursor: "c5", feedFails: true, manual: false });
	assert.equal(r.result.ok, false);
	assert.match((r.result as { reason: string }).reason, /Could not check onlyworlds\.com.*tries again/);
	assert.ok(!r.calls.some((c) => c.startsWith("create")), r.calls.join(" | "));
});

test("★ stored cursor, feed read fails, manual Save: asks with the failed-read line; Cancel creates nothing", async () => {
	const r = await saveNote({ ...OWN, cursor: "c5", feedFails: true, answer: false });
	assert.equal(r.dialogs.length, 1);
	assert.ok(r.dialogs[0].lines?.some((l) => /could not read onlyworlds\.com's change feed/.test(l)), JSON.stringify(r.dialogs[0].lines));
	assert.ok(!r.calls.some((c) => c.startsWith("create")));
});

// Amended rule 2 (Kael's correction): a kept note can sit on a device with no
// cursor (a reinstall, a vault synced by git, Syncthing or iCloud), so the
// first own-note 404 with no cursor reads the feed from the start, once.

test("★ no stored cursor, the feed reports the note's own id deleted: auto-sync refuses", async () => {
	const r = await saveNote({ ...OWN, feed: [del(VALLAKI, 3)], manual: false });
	assert.equal(r.result.ok, false);
	assert.match((r.result as { reason: string }).reason, /was deleted on onlyworlds\.com; Save element can create it again/);
	assert.ok(!r.calls.some((c) => c.startsWith("create")), r.calls.join(" | "));
	assert.deepEqual(r.calls.filter((c) => c.startsWith("changes")), ["changes epoch"]);
});

test("no stored cursor, the feed reports it deleted: the manual Save asks 'create it again?'", async () => {
	const r = await saveNote({ ...OWN, feed: [del(VALLAKI, 3)], answer: false });
	assert.equal(r.dialogs.length, 1);
	assert.match(String(r.dialogs[0].title), /create it again\?/);
	assert.ok(!r.calls.some((c) => c.startsWith("create")));
});

test("no stored cursor, nothing deleted: both saves create, no dialog", async () => {
	for (const manual of [true, false]) {
		const r = await saveNote({ ...OWN, feed: [], manual });
		assert.deepEqual(r.result, { ok: true, outcome: "created" }, `manual ${manual}`);
		assert.equal(r.dialogs.length, 0, `manual ${manual}`);
	}
});

test("no stored cursor, the full read fails: auto-sync refuses the tick, the manual Save asks with the failed-read line", async () => {
	const auto = await saveNote({ ...OWN, feedFails: true, manual: false });
	assert.equal(auto.result.ok, false);
	assert.match((auto.result as { reason: string }).reason, /tries again/);
	const manual = await saveNote({ ...OWN, feedFails: true, answer: false });
	assert.ok(manual.dialogs[0]?.lines?.some((l) => /could not read onlyworlds\.com's change feed/.test(l)));
});

/**
 * A feed that grows: each walk returns what was added since `since` (a cursor
 * "c<n>" is the length of the log it has seen), and the new cursor.
 */
function growingFeed(log: { id: string; op: string }[]) {
	const sinces: (string | undefined)[] = [];
	return {
		sinces,
		client: {
			getWorld: async () => ({ id: WID }),
			changesWalk: async (since?: string) => {
				sinces.push(since);
				const from = since ? Number(since.slice(1)) : 0;
				return { changes: log.slice(from), cursor: `c${log.length}`, head: log.length };
			},
		},
	};
}

test("★ no stored cursor: a delete made after the session's first walk is caught at the next 404 (the session reads on from its own cursor)", async () => {
	const host = { settings: { deletedOnServer: {}, syncCursors: {} } };
	const log = [{ id: KREZK, op: "upsert" }];
	const feed = growingFeed(log);
	const first = await readDeletedOnServer(host, feed.client);
	assert.equal(first.ids.has(VALLAKI), false);
	log.push({ id: VALLAKI, op: "delete" }); // deleted on the web mid-session
	const second = await readDeletedOnServer(host, feed.client);
	assert.ok(second.ids.has(VALLAKI), "the later delete was missed");
	assert.deepEqual(feed.sinces, [undefined, "c1"], "the second read walked from the start again");
	assert.deepEqual(host.settings.syncCursors, {}, "the session cursor was written to data.json");
});

test("★ a stored cursor: the second 404 reads on from where the first walk ended, not from the stored cursor again", async () => {
	const host = { settings: { deletedOnServer: {} as Record<string, string[]>, syncCursors: { [WID]: { cursor: "c1", head: 1 } } } };
	const log = [{ id: KREZK, op: "upsert" }, { id: BRAVE, op: "upsert" }];
	const feed = growingFeed(log);
	await readDeletedOnServer(host, feed.client);
	log.push({ id: VALLAKI, op: "delete" });
	const second = await readDeletedOnServer(host, feed.client);
	assert.ok(second.ids.has(VALLAKI));
	assert.deepEqual(feed.sinces, ["c1", "c2"]);
	assert.deepEqual(host.settings.syncCursors[WID], { cursor: "c1", head: 1 }, "Download's cursor was moved");
});

test("a later re-create clears the session's delete, and a later delete after Create again is caught", async () => {
	const host = { settings: { deletedOnServer: {}, syncCursors: {} } };
	const log = [{ id: VALLAKI, op: "delete" }];
	const feed = growingFeed(log);
	assert.ok((await readDeletedOnServer(host, feed.client)).ids.has(VALLAKI));
	log.push({ id: VALLAKI, op: "upsert" });
	assert.equal((await readDeletedOnServer(host, feed.client)).ids.has(VALLAKI), false);
	log.push({ id: VALLAKI, op: "delete" });
	assert.ok((await readDeletedOnServer(host, feed.client)).ids.has(VALLAKI));
});

// --- Kael's delta read, low 3: keel's 409 resync_required --------------------

test("★ a feed answering 409 resync_required: auto-sync refuses and says Download World to catch up, not 'tries again'", async () => {
	const r = await saveNote({ ...OWN, cursor: "c5", feedResync: true, manual: false });
	assert.equal(r.result.ok, false);
	const reason = (r.result as { reason: string }).reason;
	assert.match(reason, /Download world to catch up/);
	assert.doesNotMatch(reason, /tries again/);
	assert.ok(!r.calls.some((c) => c.startsWith("create")));
});

test("the manual Save asks with the catch-up line", async () => {
	const r = await saveNote({ ...OWN, cursor: "c5", feedResync: true, answer: false });
	assert.ok(r.dialogs[0]?.lines?.some((l) => /Download world to catch up/.test(l)), JSON.stringify(r.dialogs[0]?.lines));
});

// --- Kael's third read, 4b: a stored cursor past the server's head ----------

test("★ a feed whose head is below the stored head (a server restore) cannot tell: auto-sync refuses and points to Download World", async () => {
	const r = await saveNote({ ...OWN, cursor: "c5", feed: [], feedHead: 3, manual: false });
	assert.equal(r.result.ok, false);
	assert.match((r.result as { reason: string }).reason, /restored.*Download world/);
	assert.ok(!r.calls.some((c) => c.startsWith("create")));
});

test("the manual Save asks, saying the server was restored since this device's last Download", async () => {
	const r = await saveNote({ ...OWN, cursor: "c5", feed: [], feedHead: 3, answer: false });
	assert.equal(r.dialogs.length, 1);
	assert.ok(r.dialogs[0].lines?.some((l) => /restored/.test(l)), JSON.stringify(r.dialogs[0].lines));
});

test("stored cursor, feed read fine, nothing deleted: no dialog, both ways", async () => {
	for (const manual of [true, false]) {
		const r = await saveNote({ ...OWN, cursor: "c5", feed: [], manual });
		assert.deepEqual(r.result, { ok: true, outcome: "created" });
		assert.equal(r.dialogs.length, 0, `manual ${manual}`);
	}
});

test("with a stored cursor and no delete in the feed, the dialog makes no such caveat", async () => {
	const r = await saveNote({ notes: IREENA_TO_VALLAKI, cursor: "c5", feed: [] });
	assert.equal(r.dialogs.length, 1);
	assert.equal(r.dialogs[0].cannotTell, false);
});
