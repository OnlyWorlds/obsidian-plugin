/**
 * Text typed in an open editor and not yet saved is on no disk: Obsidian writes an editor's text about two seconds after the
 * last key, and `vault.read` and `vault.process` see the file only. Before a write reads a note, and before each try of its
 * replace, every open markdown view of that note is saved, so the typed text reaches the disk, no longer hashes to the
 * note's mark, and the copy rule keeps it. Only the views of the note being written are saved; a view with no `save` is
 * passed over.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import type { MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { PasteWorldCommand } from "../Commands/PasteWorldCommand";

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

test("★ Paste world saves an open editor before it writes over the note", async () => {
	const { app, vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	mock.openEditor(NOTE, typedOver(vault, NOTE));
	await new PasteWorldCommand(app, {} as never).generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Pasted." }] }, false);
	assert.ok(inACopy(vault, TYPED), "the editor's unsaved text is in no copy");
	assert.match(vault.contentAt(NOTE) ?? "", /Pasted\./);
});

test("★ only the open views of the note being written are saved, and a view with no save is passed over", async () => {
	const { vault, mock, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	const other = mock.openEditor(OTHER_NOTE, typedOver(vault, OTHER_NOTE));
	mock.openEditor(NOTE, typedOver(vault, NOTE), false);
	const editor = mock.openEditor(NOTE, typedOver(vault, NOTE));
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: ID, name: "Ireena", description: "Changed on the server." }] }, false);
	assert.ok(editor.saves > 0, "the open editor of the note being written was not saved");
	assert.equal(other.saves, 0, "an editor of a note the pull did not write was saved");
	assert.notEqual(other.pending, null, "the other note's editor lost its unsaved text");
	assert.doesNotMatch(vault.contentAt(OTHER_NOTE) ?? "", new RegExp(TYPED.replace(/[.,]/g, "\\$&")));
});

test("a workspace with no getLeavesOfType (an older stand-in) writes as before", async () => {
	const { app, vault, dl } = await world();
	(app.workspace as unknown as { getLeavesOfType?: unknown }).getLeavesOfType = undefined;
	await dl.generateElementNotes(ELEMENTS, both("A noble.", "A priest."), false);
	await dl.generateElementNotes(ELEMENTS, both("Changed on the server.", "A priest."), false);
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./);
});
