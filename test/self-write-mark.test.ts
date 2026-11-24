/**
 * A self-write mark expires. A writer marks a note before its vault.modify,
 * and the modify event that write sends is skipped by auto-sync. A modify
 * that rejects sends no event, so the mark stayed until the note's next
 * modify, the person's own edit, which was swallowed and never pushed. A mark
 * now holds for AutoSyncEngine.SELF_WRITE_TTL_MS; an older one is spent and
 * the event is the person's. One mark still swallows one event.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { AutoSyncEngine } from "../sync/auto-sync";

const A_PATH = "OnlyWorlds/Worlds/W/Elements/Character/Bob.md";
const B_PATH = "OnlyWorlds/Worlds/W/Elements/Character/Kai.md";
const note = (id: string) => `---\nname: N\nid: ${id}\n---\n\n### Description\n\nText.\n`;

/** The real engine and its real modify listener, a fake clock, and the notes it schedules a save of. */
async function harness() {
	const { app, vault } = makeApp();
	const a = (await vault.seed(A_PATH, note("019e0000-0000-7000-8000-0000000000f1"))) as unknown as TFile;
	const b = (await vault.seed(B_PATH, note("019e0000-0000-7000-8000-0000000000f2"))) as unknown as TFile;
	let listener: (f: unknown) => void = () => undefined;
	(app.vault as unknown as { on(name: string, cb: (f: unknown) => void): unknown }).on = (name, cb) => {
		if (name === "modify") listener = cb;
		return {};
	};
	const clock = { t: 1_000_000 };
	const plugin = { settings: { apiKey: "", debounceMs: 5, autoSync: true }, setSyncStatus: () => undefined, registerEvent: () => undefined };
	const engine = new AutoSyncEngine(app as App, plugin as never, () => clock.t);
	const scheduled: string[] = [];
	(engine as unknown as { scheduleSync(f: TFile): void }).scheduleSync = (f) => scheduled.push(f.path);
	engine.registerListeners();
	/** A modify event for `f`, the listener's element check settled. */
	const modify = async (f: TFile) => {
		listener(f);
		await new Promise((r) => setTimeout(r, 0));
	};
	return { engine, a, b, clock, scheduled, modify };
}

test("a mark then a modify 100 ms later is swallowed once; the next modify is the person's", async () => {
	const h = await harness();
	h.engine.markSelfWrite(A_PATH);
	h.clock.t += 100;
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, [], "the plugin's own write was taken for an edit");
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, [A_PATH], "the person's edit after it was swallowed");
});

test("★ a mark whose write never came (31 s, past the limit) does not swallow the person's next edit", async () => {
	const h = await harness();
	h.engine.markSelfWrite(A_PATH);
	h.clock.t += 31_000;
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, [A_PATH], "the person's edit was swallowed by a stale mark");
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, [A_PATH, A_PATH], "the stale mark was not spent");
});

test("a mark at exactly the limit still holds", async () => {
	const h = await harness();
	h.engine.markSelfWrite(A_PATH);
	h.clock.t += AutoSyncEngine.SELF_WRITE_TTL_MS;
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, []);
});

test("two marks on one path before one modify swallow exactly one event", async () => {
	const h = await harness();
	h.engine.markSelfWrite(A_PATH);
	h.clock.t += 50;
	h.engine.markSelfWrite(A_PATH);
	h.clock.t += 50;
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, []);
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, [A_PATH]);
});

test("a mark on one note never swallows another note's modify", async () => {
	const h = await harness();
	h.engine.markSelfWrite(A_PATH);
	h.clock.t += 100;
	await h.modify(h.b);
	assert.deepEqual(h.scheduled, [B_PATH]);
	await h.modify(h.a);
	assert.deepEqual(h.scheduled, [B_PATH], "the mark on A was spent by B's event");
});
