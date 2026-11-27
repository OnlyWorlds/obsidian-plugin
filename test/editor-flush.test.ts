/**
 * Text typed in an open editor and not yet saved is on no disk: Obsidian writes an editor's text about two seconds after the
 * last key, and `vault.read` and `vault.process` see the file only. Before a pull reads a note, and before each try of its
 * replace, every open markdown view of that note is saved, so the typed text reaches the disk, no longer hashes to the
 * note's mark, and the copy rule keeps it. Only the views of the note being written are saved; a view with no `save` is
 * passed over. Only Download flushes: a pull writes the server's bytes, so the save auto-sync schedules from the flush's
 * modify event finds nothing to send. Paste world writes bytes the server does not hold and never flushes; text typed and not
 * yet saved under a note it replaces is its known limit.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import type { MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { PasteWorldCommand } from "../Commands/PasteWorldCommand";
import { FLUSH_SAVE_TIMEOUT } from "../vault/element-file";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const NOTE = `${ELEMENTS}/Character/Ireena.md`;
const OTHER_NOTE = `${ELEMENTS}/Character/Kolyan.md`;
const KEPT = `${W}/Kept edits/`;
const ID = "019a0000-0000-7000-8000-0000000002f1";
const OTHER = "019a0000-0000-7000-8000-0000000002f2";
const TYPED = "Typed in the editor, not yet saved.";

async function world() {
	const { app, vault, mock } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	return { app, vault, mock, dl: new DownloadWorldCommand(app, {}) };
}
const both = (a: string, b: string) => ({ Character: [{ id: ID, name: "Ireena", description: a }, { id: OTHER, name: "Kolyan", description: b }] });
const copies = (vault: MockVault) => [...vault.files.keys()].filter((p) => p.startsWith(KEPT));
/** The note's text as its editor holds it: the disk's, with the person's typing in the description. */
const typedOver = (vault: MockVault, path: string) => (vault.contentAt(path) ?? "").replace("### Description\n\n", `### Description\n\n${TYPED} `);
const inACopy = (vault: MockVault, text: string) => copies(vault).some((p) => (vault.contentAt(p) ?? "").includes(text));

test("★ a pull copies text typed in an open editor and not yet saved, then writes the world's copy", async () => {
	const { vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	const editor = mock.openEditor(NOTE, typedOver(vault, NOTE));
	const r = await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest."), false);
	assert.ok(inACopy(vault, TYPED), "the editor's unsaved text is in no copy: the pull never saw it");
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
	assert.deepEqual(r.copied, ['Character "Ireena"']);
	assert.equal(editor.saves > 0, true);
});

test("★ the hidden stub pass saves an open editor first: its unsaved text is copied before the fields are emptied", async () => {
	const { app, vault, mock } = await world();
	const WID = "019e0000-0000-7000-8000-0000000007ee";
	const changes = (rows: unknown[], head: number) => setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "W", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: `c${head}`, has_more: false, head, changes: rows } };
		return { status: 404, json: {} };
	});
	const plugin = { settings: { syncCursors: {} }, saveSettings: async () => {} };
	const run = () => new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
	changes([{ op: "upsert", type: "character", id: ID, change_seq: 1, updated_at: "x", element: { type: "character", id: ID, name: "Ireena", description: "A noble." } }], 1);
	await run();
	mock.openEditor(NOTE, typedOver(vault, NOTE));
	changes([{ op: "delete", type: "character", id: ID, change_seq: 2, updated_at: "x", reason: "hidden" }], 2);
	__notices.length = 0;
	await run();
	assert.ok((vault.contentAt(NOTE) ?? "").includes("Hidden by the world's owner."), vault.contentAt(NOTE));
	assert.ok(inACopy(vault, TYPED), `the editor's unsaved text is in no copy: ${__notices.join(" | ")}`);
});

test("★ Paste world does not flush or save an open editor: its copy and its write take the note as it is on disk", async () => {
	const { app, vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	// Saved typing on disk: the note no longer matches its mark, so Paste world copies it first.
	vault.files.get(NOTE)!.content = (vault.contentAt(NOTE) ?? "").replace("A noble.", "A noble, typed and saved.");
	const dirty = mock.openEditor(NOTE, typedOver(vault, NOTE));
	const throwing = mock.openEditor(OTHER_NOTE, typedOver(vault, OTHER_NOTE), { onSave: async () => { throw new Error("a save Paste world must not ask for"); } });
	__notices.length = 0;
	const r = await new PasteWorldCommand(app, {} as never).generateElementNotes(ELEMENTS, both("Pasted.", "Pasted too."), false);
	assert.equal(dirty.saves, 0, "Paste world saved an open editor (its modify event would let auto-sync send the pasted bytes)");
	assert.equal(throwing.saves, 0, "Paste world saved an open editor");
	assert.equal(r.stopped, null, r.stopped ?? "");
	assert.match(vault.contentAt(NOTE) ?? "", /Pasted\./);
	assert.match(vault.contentAt(OTHER_NOTE) ?? "", /Pasted too\./);
	assert.ok(inACopy(vault, "A noble, typed and saved."), "the bytes on disk were not copied");
	// The known limit: text typed in the editor and not yet saved is not in the copy.
	assert.ok(!inACopy(vault, TYPED));
});

test("★ only the open views of the note being written are saved, and a view with no save is passed over", async () => {
	const { vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	const other = mock.openEditor(OTHER_NOTE, typedOver(vault, OTHER_NOTE));
	mock.openEditor(NOTE, typedOver(vault, NOTE), { withSave: false });
	const editor = mock.openEditor(NOTE, typedOver(vault, NOTE));
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Changed on the server." }] }, false);
	assert.ok(editor.saves > 0, "the open editor of the note being written was not saved");
	assert.equal(other.saves, 0, "an editor of a note the pull did not write was saved");
	assert.notEqual(other.pending, null, "the other note's editor lost its unsaved text");
	assert.doesNotMatch(vault.contentAt(OTHER_NOTE) ?? "", new RegExp(TYPED.replace(/[.,]/g, "\\$&")));
});

test("★ the write is built from the saved editor text: a property typed in the editor and not yet saved stays in the note", async () => {
	const { vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	mock.openEditor(NOTE, (vault.contentAt(NOTE) ?? "").replace(`id: ${ID}\n`, `id: ${ID}\nmood: grim\n`));
	await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
	assert.match(vault.contentAt(NOTE) ?? "", /^mood: grim$/m, "the person's property, typed and not yet saved, left the note (it is only in a copy)");
});

test("★ a dirty view is saved once, as a plain save with no self-write mark of its own; a clean view is not saved", async () => {
	const log: string[] = [];
	const { app, vault, mock } = await world();
	const plugin = { autoSync: { markSelfWrite: (p: string) => log.push(`mark ${p}`) } };
	const dl = new DownloadWorldCommand(app, {}, plugin as never);
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	const dirty = mock.openEditor(NOTE, typedOver(vault, NOTE), { log });
	const clean = mock.openEditor(OTHER_NOTE, null, { log });
	const v = app.vault as unknown as { modify(f: unknown, c: string): Promise<void> };
	const modify = v.modify.bind(v);
	v.modify = async (f, c) => {
		log.push(`write ${(f as { path: string }).path}`);
		return modify(f, c);
	};
	log.length = 0;
	await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest, changed."), false);
	assert.equal(dirty.saves, 1, `the dirty view was saved ${dirty.saves} times`);
	assert.equal(clean.saves, 0, "a clean view was saved");
	for (const path of [NOTE, OTHER_NOTE]) {
		const of = log.filter((x) => x.endsWith(path));
		const marks = of.filter((x) => x.startsWith("mark")).length;
		const writes = of.filter((x) => x.startsWith("write")).length - of.filter((x) => x.startsWith("save")).length;
		assert.equal(marks, writes, `the flush took a self-write mark of its own for ${path}: ${of.join(" | ")}`);
	}
});

test("★ a view that differs from its file only in line endings is clean: no save, no mark", async () => {
	const log: string[] = [];
	const { app, vault, mock } = await world();
	const plugin = { autoSync: { markSelfWrite: (p: string) => log.push(`mark ${p}`) } };
	const dl = new DownloadWorldCommand(app, {}, plugin as never);
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	const crlf = mock.openEditor(OTHER_NOTE, (vault.contentAt(OTHER_NOTE) ?? "").replace(/\n/g, "\r\n"), { log });
	log.length = 0;
	await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest, changed."), false);
	assert.equal(crlf.saves, 0, "a view that differs only in line endings was saved");
});

test("★ an editor whose save does not return in time: its note is left as it was and named, and the pull goes on", { timeout: 5000 }, async () => {
	const { vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	const before = vault.contentAt(NOTE);
	mock.openEditor(NOTE, typedOver(vault, NOTE), { onSave: () => new Promise<void>(() => undefined) });
	const was = FLUSH_SAVE_TIMEOUT.ms;
	FLUSH_SAVE_TIMEOUT.ms = 30;
	__notices.length = 0;
	try {
		const r = await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest, changed."), false);
		assert.equal(vault.contentAt(NOTE), before, "the note whose editor did not save was written over");
		assert.match(vault.contentAt(OTHER_NOTE) ?? "", /A priest, changed\./, "the pull stopped at the note whose editor did not save");
		assert.equal(r.failed.length, 1, JSON.stringify(r.failed));
		assert.match(r.failed[0].reason, /did not save/, r.failed[0].reason);
		assert.ok(__notices.some((n) => n.includes('Character "Ireena"') && /did not save/.test(n)), __notices.join(" | "));
	} finally {
		FLUSH_SAVE_TIMEOUT.ms = was;
	}
});

/** A Download over the feed `rows` at `head`, through downloadWithKey. */
function feed(app: ReturnType<typeof makeApp>["app"], plugin: unknown) {
	const WID = "019e0000-0000-7000-8000-0000000008ee";
	return async (rows: unknown[], head: number) => {
		setRequestUrl((r) => {
			const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
			if (path === "/world") return { status: 200, json: { id: WID, name: "W", description: "" } };
			if (path === "/changes") return { status: 200, json: { cursor: `c${head}`, has_more: false, head, changes: rows } };
			return { status: 404, json: {} };
		});
		__notices.length = 0;
		await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
	};
}
const upsertRow = (seq: number, extra: Record<string, unknown> = {}) =>
	({ op: "upsert", type: "character", id: ID, change_seq: seq, updated_at: "x", element: { type: "character", id: ID, name: "Ireena", description: "A noble.", ...extra } });
const hiddenRow = (seq: number) => ({ op: "delete", type: "character", id: ID, change_seq: seq, updated_at: "x", reason: "hidden" });
const GATE = "Met her at the gate, not yet saved.";

test("★ text typed on a hidden stub and not yet saved stays in the note when the element comes back whole", async () => {
	const { app, vault, mock } = await world();
	const pull = feed(app, { settings: { syncCursors: {} }, saveSettings: async () => {} });
	await pull([upsertRow(1)], 1);
	await pull([hiddenRow(2)], 2);
	const stub = vault.contentAt(NOTE) ?? "";
	assert.ok(stub.includes("Hidden by the world's owner."), stub);
	mock.openEditor(NOTE, stub.replace("Hidden by the world's owner.\n", `Hidden by the world's owner.\n\n${GATE}\n`));
	await pull([upsertRow(3, { description: "A noble, back in view." })], 3);
	assert.match(vault.contentAt(NOTE) ?? "", /A noble, back in view\./);
	assert.ok((vault.contentAt(NOTE) ?? "").includes(GATE), `the unsaved line left the returning note (only in a copy): ${vault.contentAt(NOTE)}`);
});

test("★ a line typed outside the fields of a whole note and not yet saved stays in the hidden stub made of it", async () => {
	const { app, vault, mock } = await world();
	const pull = feed(app, { settings: { syncCursors: {} }, saveSettings: async () => {} });
	await pull([upsertRow(1)], 1);
	const whole = vault.contentAt(NOTE) ?? "";
	mock.openEditor(NOTE, whole.replace("\n---\n\n", `\n---\n\n${GATE}\n\n`));
	await pull([hiddenRow(2)], 2);
	const stub = vault.contentAt(NOTE) ?? "";
	assert.ok(stub.includes("Hidden by the world's owner."), stub);
	assert.ok(stub.includes(GATE), `the unsaved line left the stub (only in a copy): ${stub}`);
});

test("★ text typed in the editor while the note's copy is being written ends in a copy or the note, never in neither", async () => {
	const { app, vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	// Saved typing: the note no longer matches its mark, so the pull copies it first.
	const e = vault.files.get(NOTE);
	assert.ok(e);
	e.content = e.content.replace("A noble.", "A noble, typed and saved.");
	const editor = mock.openEditor(NOTE, null);
	const DURING = "Typed in the editor during the copy.";
	const v = app.vault as unknown as { create(p: string, c: string): Promise<unknown> };
	const create = v.create.bind(v);
	let once = false;
	v.create = async (p, c) => {
		if (p.startsWith(KEPT) && !once) {
			once = true;
			editor.pending = (vault.contentAt(NOTE) ?? "").replace("### Description\n\n", `### Description\n\n${DURING} `);
		}
		return create(p, c);
	};
	await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest."), false);
	assert.ok(once, "no copy was written");
	assert.ok(inACopy(vault, DURING) || (vault.contentAt(NOTE) ?? "").includes(DURING),
		"text typed in the editor during the copy is in neither a copy nor the note");
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
});

const KOL_ID = OTHER;
const ISM_ID = "019a0000-0000-7000-8000-0000000002f3";
const ISM_NOTE = `${ELEMENTS}/Character/Ismark.md`;
const row = (id: string, name: string, seq: number, description: string) =>
	({ op: "upsert", type: "character", id, change_seq: seq, updated_at: "x", element: { type: "character", id, name, description } });

test("★ a flush that throws before the pull reads a note leaves that note as it was and named; the other two land", async () => {
	const { app, vault, mock } = await world();
	const pull = feed(app, { settings: { syncCursors: {} }, saveSettings: async () => {} });
	await pull([row(ID, "Ireena", 1, "A noble."), row(KOL_ID, "Kolyan", 2, "A priest."), row(ISM_ID, "Ismark", 3, "A brother.")], 3);
	await pull([hiddenRow(4)], 4);
	const stub = (vault.contentAt(NOTE) ?? "").replace("Hidden by the world's owner.\n", `Hidden by the world's owner.\n\nMy line on the stub.\n`);
	vault.files.get(NOTE)!.content = stub;
	let saves = 0;
	mock.openEditor(NOTE, stub.replace("My line on the stub.", `My line on the stub. ${TYPED}`), {
		onSave: async () => { if (++saves === 1) throw new Error("the editor could not save"); },
	});
	await pull([row(ID, "Ireena", 5, "Back in view."), row(KOL_ID, "Kolyan", 6, "Priest, changed."), row(ISM_ID, "Ismark", 7, "Brother, changed.")], 7);
	assert.equal(vault.contentAt(NOTE), stub, "the note whose flush failed was written (its kept line taken from a read the flush never saved into)");
	assert.match(vault.contentAt(OTHER_NOTE) ?? "", /Priest, changed\./);
	assert.match(vault.contentAt(ISM_NOTE) ?? "", /Brother, changed\./);
	assert.ok(__notices.some((n) => n.includes('Character "Ireena"') && /could not save/.test(n)), __notices.join(" | "));
});

test("a workspace with no getLeavesOfType (an older stand-in) writes as before", async () => {
	const { app, vault, dl } = await world();
	(app.workspace as unknown as { getLeavesOfType?: unknown }).getLeavesOfType = undefined;
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
});
