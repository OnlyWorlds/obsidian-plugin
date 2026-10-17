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
			for (const i of items) server.set(String(i.element.id), i.element);
			return { errors: false, items: items.map((i) => ({ status: 201, id: i.element.id })) };
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
	const dialogs: { items?: unknown[]; leftOut?: unknown[]; cannotTell?: boolean; lines?: string[]; choose(b: boolean): void }[] = [];
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
	return { result: await run, calls, bulks, sent, dialogs, settings, notices: [...__notices], vault, file };
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
	assert.equal(r.dialogs.length, 1);
	assert.deepEqual(r.dialogs[0].items, [{ type: "location", name: "Krezk" }]);
	assert.deepEqual(r.dialogs[0].leftOut, [{ type: "location", name: "Vallaki" }]);
	for (const b of r.bulks) assert.ok(!b.includes(VALLAKI), "a deleted element was recreated");
});

test("★ the only target deleted: no dialog, nothing recreated, the notice names it", async () => {
	const r = await manualSave([VALLAKI], {
		"Character/Ireena.md": note(IREENA, "Ireena", 'birthplace: "[[Vallaki]]"\n'),
		"Location/Vallaki.md": note(VALLAKI, "Vallaki"),
	});
	assert.equal(r.dialogs.length, 0);
	assert.deepEqual(r.bulks, []);
	assert.ok(
		r.notices.some((n) => n.includes('Location "Vallaki" was deleted on onlyworlds.com and is left out.')),
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
	assert.equal(r.dialogs.length, 1);
	assert.equal(r.dialogs[0].cannotTell, true);
	assert.deepEqual(r.calls.filter((c) => c.startsWith("changes")), [], "no cursor, no feed read");
});

test("with a stored cursor and no delete in the feed, the dialog makes no such caveat", async () => {
	const r = await saveNote({ notes: IREENA_TO_VALLAKI, cursor: "c5", feed: [] });
	assert.equal(r.dialogs.length, 1);
	assert.equal(r.dialogs[0].cannotTell, false);
});
