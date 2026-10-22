/**
 * Nameless elements no longer overwrite each other (3.8.0, Fix 1; Kael's
 * measurement 2026-10-22: Moppetopia's 131 nameless Markers downloaded to 113
 * files, `unnamed.md` to `unnamed (100).md` then a clock suffix that several
 * shared in one millisecond, 292 of 310 elements landed).
 *
 * The rule (WorldService.noteNameCandidates): a nameless element's note is
 * `<Type> <id tail>.md`, the tail the last 8 hex of its id, the same on every
 * download; a name past `Name (100)` falls to `Name <id tail>.md`; never the
 * clock. Run against the REAL Download through the in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, setRequestUrl } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { readElement } from "../vault/element-file";

const WID = "01a16305-0000-7000-8000-0000000000ee";
const MARKERS = "OnlyWorlds/Worlds/Moppetopia/Elements/Marker";

/** A uuidv7-shaped id: the clock front shared, as in one minute's work; the tail distinct. */
const markerId = (n: number) => `01a1206f-eaf3-73c3-abf6-7be3be${n.toString(16).padStart(6, "0")}`;

const upsert = (type: string, id: string, name: string, seq: number) => ({
	op: "upsert", type, id, change_seq: seq, updated_at: "x", element: { id, name },
});

function serve(changes: unknown[]) {
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Moppetopia", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: "c9", has_more: false, head: 9, changes } };
		return { status: 404, json: {} };
	});
}

function freshPlugin() {
	return { settings: { syncCursors: {} as Record<string, unknown> }, saveSettings: async () => {} };
}

/** element id -> note path for every element note under `folder`. */
async function notesIn(app: App, folder: string): Promise<Map<string, string[]>> {
	const out = new Map<string, string[]>();
	for (const f of app.vault.getMarkdownFiles()) {
		if (!f.path.startsWith(folder + "/")) continue;
		const el = await readElement(app, f);
		if (el) out.set(el.id, [...(out.get(el.id) ?? []), f.path]);
	}
	return out;
}

const markerChanges = (count: number) => Array.from({ length: count }, (_, i) => upsert("marker", markerId(i + 1), "", i + 1));

test("★ a world with 131 nameless Markers downloads to 131 files, each `Marker <id tail>.md`", async () => {
	const { app } = makeApp();
	serve(markerChanges(131));
	await new DownloadWorldCommand(app, { version: "t" }, freshPlugin() as never).downloadWithKey("ow_k_test", "");
	const notes = await notesIn(app, MARKERS);
	const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(MARKERS + "/"));
	assert.equal(files.length, 131);
	assert.equal(notes.size, 131, "an element has no note of its own");
	for (let i = 1; i <= 131; i++) {
		const id = markerId(i);
		assert.deepEqual(notes.get(id), [`${MARKERS}/Marker ${id.slice(-8)}.md`]);
	}
});

test("★ downloading it twice leaves 131: the same file for the same element, nothing renamed", async () => {
	const { app } = makeApp();
	(app as unknown as { realRenames: boolean }).realRenames = true;
	const plugin = freshPlugin();
	serve(markerChanges(131));
	const cmd = new DownloadWorldCommand(app, { version: "t" }, plugin as never);
	await cmd.downloadWithKey("ow_k_test", "");
	const first = await notesIn(app, MARKERS);
	await cmd.downloadWithKey("ow_k_test", "");
	const second = await notesIn(app, MARKERS);
	assert.equal(app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(MARKERS + "/")).length, 131);
	assert.deepEqual([...second.entries()].sort(), [...first.entries()].sort());
	assert.deepEqual((app as unknown as { renames: string[] }).renames, []);
});

test("★ two nameless elements of one type never share a file, even when their id tails match", async () => {
	const { app } = makeApp();
	const a = "01a1206f-0000-7000-8000-0000aaaa1234";
	const b = "01a1206f-1111-7000-8000-1111aaaa1234"; // same last 8 as `a`
	serve([upsert("marker", a, "", 1), upsert("marker", b, "  ", 2)]);
	await new DownloadWorldCommand(app, { version: "t" }, freshPlugin() as never).downloadWithKey("ow_k_test", "");
	const notes = await notesIn(app, MARKERS);
	assert.equal(notes.size, 2);
	assert.notEqual(notes.get(a)?.[0], notes.get(b)?.[0]);
	assert.deepEqual(notes.get(a), [`${MARKERS}/Marker aaaa1234.md`]);
	assert.deepEqual(notes.get(b), [`${MARKERS}/Marker ${b}.md`], "the tail is taken: the full id names it");
});

test("a nameless note from before 3.8.0 (`unnamed (N)`) moves once to its id form, then stays", async () => {
	const { app, vault } = makeApp();
	(app as unknown as { realRenames: boolean }).realRenames = true;
	const id = markerId(7);
	await vault.seed("OnlyWorlds/Worlds/Moppetopia/World.md", "# World Overview: Moppetopia\n\n- **API Key:** ow_k_test\n");
	await vault.seed(`${MARKERS}/unnamed (3).md`, `---\nid: ${id}\nname: ""\n---\n`);
	serve([upsert("marker", id, "", 1)]);
	const cmd = new DownloadWorldCommand(app, { version: "t" }, freshPlugin() as never);
	await cmd.downloadWithKey("ow_k_test", "");
	await cmd.downloadWithKey("ow_k_test", "");
	assert.deepEqual((app as unknown as { renames: string[] }).renames, [
		`${MARKERS}/unnamed (3).md -> ${MARKERS}/Marker ${id.slice(-8)}.md`,
	]);
	assert.deepEqual((await notesIn(app, MARKERS)).get(id), [`${MARKERS}/Marker ${id.slice(-8)}.md`]);
});

test("★ a name past its 100 numbered twins falls to `Name <id tail>.md`, never the clock", async () => {
	const { app } = makeApp();
	const ids = Array.from({ length: 103 }, (_, i) => markerId(i + 1));
	serve(ids.map((id, i) => upsert("character", id, "Guard", i + 1)));
	await new DownloadWorldCommand(app, { version: "t" }, freshPlugin() as never).downloadWithKey("ow_k_test", "");
	const dir = "OnlyWorlds/Worlds/Moppetopia/Elements/Character";
	const notes = await notesIn(app, dir);
	assert.equal(notes.size, 103);
	assert.deepEqual(notes.get(ids[0]), [`${dir}/Guard.md`]);
	assert.deepEqual(notes.get(ids[100]), [`${dir}/Guard (100).md`]);
	assert.deepEqual(notes.get(ids[101]), [`${dir}/Guard ${ids[101].slice(-8)}.md`]);
	assert.deepEqual(notes.get(ids[102]), [`${dir}/Guard ${ids[102].slice(-8)}.md`]);
});

test("★ named elements keep their 3.7.0 file names (fixture: three names, one a twin)", async () => {
	const { app } = makeApp();
	const dir = "OnlyWorlds/Worlds/Moppetopia/Elements/Location";
	const V = "019a0000-0000-7000-8000-0000000000a1";
	const C = "019a0000-0000-7000-8000-0000000000a2";
	const T1 = "019a0000-0000-7000-8000-0000000000a3";
	const T2 = "019a0000-0000-7000-8000-0000000000a4";
	serve([
		upsert("location", V, "Vallaki", 1),
		upsert("location", C, "Chapter 1: Into the Mists", 2),
		upsert("location", T1, "Twin", 3),
		upsert("location", T2, "Twin", 4),
	]);
	await new DownloadWorldCommand(app, { version: "t" }, freshPlugin() as never).downloadWithKey("ow_k_test", "");
	const expected = new Map([
		[V, [`${dir}/Vallaki.md`]],
		[C, [`${dir}/Chapter 1- Into the Mists.md`]],
		[T1, [`${dir}/Twin.md`]],
		[T2, [`${dir}/Twin (1).md`]],
	]);
	assert.deepEqual([...(await notesIn(app, dir)).entries()].sort(), [...expected.entries()].sort());
});

test("a second download leaves named notes where they are, a name with a `:` included (3.7.0 renamed it on every download)", async () => {
	const { app } = makeApp();
	(app as unknown as { realRenames: boolean }).realRenames = true;
	const dir = "OnlyWorlds/Worlds/Moppetopia/Elements/Location";
	const C = "019a0000-0000-7000-8000-0000000000a2";
	const T1 = "019a0000-0000-7000-8000-0000000000a3";
	const T2 = "019a0000-0000-7000-8000-0000000000a4";
	serve([upsert("location", C, "Chapter 1: Into the Mists", 1), upsert("location", T1, "Twin", 2), upsert("location", T2, "Twin", 3)]);
	const cmd = new DownloadWorldCommand(app, { version: "t" }, freshPlugin() as never);
	await cmd.downloadWithKey("ow_k_test", "");
	const first = await notesIn(app, dir);
	await cmd.downloadWithKey("ow_k_test", "");
	assert.deepEqual([...(await notesIn(app, dir)).entries()].sort(), [...first.entries()].sort());
	assert.deepEqual((app as unknown as { renames: string[] }).renames, []);
});
