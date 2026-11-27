/**
 * A plugin write cancels auto-sync's save of that note. Every plugin write marks its path just before the real write
 * (markSelfWrite); the mark now also drops the save already scheduled for that path (its timer, or its place in the queue
 * for a free save slot). The person's earlier edit, scheduled for later, would otherwise be sent after the plugin replaced
 * the note, carrying the plugin's bytes (Paste world's pasted ones) with the note's If-Match unchanged. Only that path's
 * save goes; an edit with no plugin write after it is sent as ever. The real engine throughout, its modify listener fed by
 * the vault's writes.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { PasteWorldCommand } from "../Commands/PasteWorldCommand";
import { AutoSyncEngine } from "../sync/auto-sync";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const NOTE = `${ELEMENTS}/Character/Ireena.md`;
const OTHER_NOTE = `${ELEMENTS}/Character/Kolyan.md`;
const ID = "019a0000-0000-7000-8000-0000000003f1";
const OTHER = "019a0000-0000-7000-8000-0000000003f2";
const both = (a: string, b: string) => ({ Character: [{ id: ID, name: "Ireena", description: a }, { id: OTHER, name: "Kolyan", description: b }] });

type Engine = { timers: Map<string, ReturnType<typeof setTimeout>>; activeSaves: number; waitingSaves: unknown[] };

async function harness(debounceMs: number) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	await new DownloadWorldCommand(app, {}).generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	const listeners: ((f: unknown) => void)[] = [];
	const v = app.vault as unknown as { on(name: string, cb: (f: unknown) => void): unknown; modify(f: unknown, c: string): Promise<void> };
	v.on = (name, cb) => {
		if (name === "modify") listeners.push(cb);
		return {};
	};
	const modify = v.modify.bind(v);
	v.modify = async (f, c) => {
		await modify(f, c);
		for (const cb of listeners) cb(f);
	};
	const statuses: string[] = [];
	const plugin = { settings: { apiKey: "", debounceMs, autoSync: true }, setSyncStatus: (s: string) => statuses.push(s), registerEvent: () => {} };
	const engine = new AutoSyncEngine(app as App, plugin as never);
	engine.registerListeners();
	/** The person's edit of a note through the vault, as Obsidian's editor saves it. */
	const edit = async (path: string, text: string) => {
		await app.vault.modify(app.vault.getAbstractFileByPath(path) as TFile, (vault.contentAt(path) ?? "").replace("### Description\n\n", `### Description\n\n${text} `));
		await new Promise((r) => setTimeout(r, 5)); // the listener's element check settles
	};
	const pending = () => [...(engine as unknown as Engine).timers.keys()];
	const stop = () => { for (const t of (engine as unknown as Engine).timers.values()) clearTimeout(t); };
	return { app, vault, engine, statuses, edit, pending, stop };
}

test("★ an edit schedules a save; Paste world then writes the note, and the save is dropped: nothing is sent", async () => {
	const h = await harness(40);
	await h.edit(NOTE, "My edit.");
	assert.deepEqual(h.pending(), [NOTE], "the edit scheduled no save");
	await new PasteWorldCommand(h.app, {} as never, undefined, (p: string) => h.engine.markSelfWrite(p))
		.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Pasted." }] }, false);
	assert.deepEqual(h.pending(), [], "the save scheduled before Paste world's write is still pending: it would send the pasted bytes");
	await new Promise((r) => setTimeout(r, 80));
	assert.ok(!h.statuses.includes("syncing"), `a save was sent after the plugin replaced the note: ${h.statuses.join(" | ")}`);
	h.stop();
});

test("★ an edit schedules a save; a pull then writes the note, and the save is dropped", async () => {
	const h = await harness(40);
	await h.edit(NOTE, "My edit.");
	assert.deepEqual(h.pending(), [NOTE]);
	await new DownloadWorldCommand(h.app, {}, { autoSync: h.engine } as never).generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest."), false);
	assert.deepEqual(h.pending(), [], "the save scheduled before the pull's write is still pending");
	await new Promise((r) => setTimeout(r, 80));
	assert.ok(!h.statuses.includes("syncing"), h.statuses.join(" | "));
	h.stop();
});

test("the cancel is exact: a plugin write of one note leaves another note's scheduled save in place", async () => {
	const h = await harness(10_000);
	await h.edit(NOTE, "My edit.");
	await h.edit(OTHER_NOTE, "My other edit.");
	h.engine.markSelfWrite(NOTE);
	assert.deepEqual(h.pending(), [OTHER_NOTE]);
	h.stop();
});

test("an edit with no plugin write after it is still sent", async () => {
	const h = await harness(5);
	await h.edit(NOTE, "My edit.");
	await new Promise((r) => setTimeout(r, 60));
	assert.ok(h.statuses.includes("syncing"), `the person's edit was not sent: ${h.statuses.join(" | ")}`);
	h.stop();
});

test("★ a save queued for a free slot is dropped by a plugin write of its note", async () => {
	const h = await harness(5);
	const e = h.engine as unknown as Engine;
	e.activeSaves = AutoSyncEngine.MAX_PARALLEL_SAVES; // every slot taken: the next save waits in the queue
	await h.edit(NOTE, "My edit.");
	await new Promise((r) => setTimeout(r, 30));
	assert.equal(e.waitingSaves.length, 1, "the save did not queue");
	h.engine.markSelfWrite(NOTE);
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(e.waitingSaves.length, 0, "the queued save of the note the plugin wrote is still waiting");
	assert.equal(e.activeSaves, AutoSyncEngine.MAX_PARALLEL_SAVES, "the dropped save took or freed a slot");
	assert.ok(!h.statuses.includes("syncing"), h.statuses.join(" | "));
	h.stop();
});
