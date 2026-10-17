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

test("★ Download keeps the ids the change feed reported deleted, per world; a later upsert of the id clears it", async () => {
	const { app } = makeApp();
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	await download(app, plugin, [upsert(VALLAKI, "Vallaki", 1), upsert(KREZK, "Krezk", 2), del(VALLAKI, 3)], 3);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [VALLAKI]);
	await download(app, plugin, [upsert(VALLAKI, "Vallaki", 4), del(KREZK, 5)], 5);
	assert.deepEqual(plugin.settings.deletedOnServer?.[WID], [KREZK]);
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
	/** Every dialog is answered with this (default true: Create). */
	answer?: boolean;
	/** The manual Save Element (default), or auto-sync's save. */
	manual?: boolean;
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
		getWorld: async () => ({ id: WID, name: "W" }),
		changesWalk: async (since?: string) => {
			calls.push(`changes ${since ?? "epoch"}`);
			if (o.feedFails) throw new V2ApiError(503, "unavailable", "Service Unavailable", null);
			return { changes: o.feed ?? [], cursor: "c-next", head: 99 };
		},
		get: async (type: string, id: string) => {
			calls.push(`get ${type} ${id}`);
			const el = server.get(id);
			if (el) return { id, ...el };
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

test("★ no stored cursor: the dialog says this device cannot tell a never-uploaded note from a deleted one", async () => {
	const r = await saveNote({ notes: IREENA_TO_VALLAKI });
	assert.equal(r.createFirst.length, 1);
	assert.equal(r.createFirst[0].cannotTell, true);
	assert.deepEqual(r.calls.filter((c) => c.startsWith("changes")), [], "no cursor, no feed read");
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

// --- Kael's second read, N1: the deleted element's OWN note -----------------

const VALLAKI_NOTE = { "Location/Vallaki.md": note(VALLAKI, "Vallaki") };

test("★ auto-sync on a deleted element's own note refuses: nothing created, the notice says Save Element can create it again", async () => {
	const r = await saveNote({ notes: VALLAKI_NOTE, save: "Location/Vallaki.md", deleted: [VALLAKI], manual: false });
	assert.equal(r.result.ok, false);
	assert.match((r.result as { reason: string }).reason, /Vallaki was deleted on onlyworlds\.com; Save Element can create it again/);
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

test("no stored cursor, auto-sync: creates as today (a kept note of a deleted element only comes from a Download)", async () => {
	const r = await saveNote({ ...OWN, manual: false });
	assert.deepEqual(r.result, { ok: true, outcome: "created" });
	assert.equal(r.dialogs.length, 0);
});

test("★ no stored cursor, manual Save: asks with the never-downloaded line on its own create; Create creates", async () => {
	const r = await saveNote({ ...OWN });
	assert.equal(r.dialogs.length, 1);
	assert.ok(r.dialogs[0].lines?.some((l) => /has not downloaded this world/.test(l)), JSON.stringify(r.dialogs[0].lines));
	assert.deepEqual(r.result, { ok: true, outcome: "created" });
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
