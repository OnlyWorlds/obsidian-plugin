/**
 * A stub written over a note replaces the person's text in the note's fields, so it copies the note first, by the rule every
 * pull write keeps: a known-of stub (after a view reset) and a hidden-by-owner stub copy a note whose bytes do not hash to its
 * mark, or that has none, into Kept edits/. A note that is a stub already is no exception: a heading of the person's on a
 * known-of note reads as a custom field, which the hidden stub empties. A stub's write records the mark of the bytes it
 * wrote, as every pull write does, so an untouched stub is not copied again, and one that comes back whole is no copy.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import type { MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { KNOWN_OF_LINE } from "../sync/known-of";
import { HIDDEN_STUB_LINE } from "../sync/hidden-on-server";

const WID = "019e0000-0000-7000-8000-0000000006ee";
const ZEL = "019e0000-0000-7000-8000-0000000006c1";
const IRE = "019e0000-0000-7000-8000-0000000006c2";
const W = "OnlyWorlds/Worlds/Barovia";
const KEPT = `${W}/Kept edits/`;
const ZEL_NOTE = `${W}/Elements/Character/Zelraun.md`;

type Settings = { syncCursors: Record<string, unknown>; [k: string]: unknown };

const upsert = (element: Record<string, unknown>, seq: number) => ({ op: "upsert", type: "character", id: element.id, change_seq: seq, updated_at: "x", element });
const whole = (id: string, name: string, seq: number, extra: Record<string, unknown> = {}) => upsert({ type: "character", id, name, ...extra }, seq);
const hidden = (id: string, seq: number) => ({ op: "delete", type: "character", id, change_seq: seq, updated_at: "x", reason: "hidden" });
/** A Character as keel serves it known of. */
const stubOf = (id: string, name: string, seq: number, kept: Record<string, unknown> = {}) => ({
	type: "character", id, name, description: "", supertype: "", subtype: "", image_url: "", physicality: "", background: "",
	created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", change_seq: seq, ...kept, known_of: true,
});
const VIEW = { error: { code: "resync_required", message: "Your view of this world changed.", reason: "view" } };

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

async function wholeZel() {
	const { app, vault } = makeApp();
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	await download(app, plugin, [
		whole(ZEL, "Zelraun", 1, { description: "A knight of Barovia.", background: "Born in Krezk." }),
		whole(IRE, "Ireena", 2, { description: "A noble." }),
	], 2);
	assert.match(vault.contentAt(ZEL_NOTE) ?? "", /A knight of Barovia\./);
	return { app, vault, plugin };
}
const copies = (vault: MockVault) => [...vault.files.keys()].filter((p) => p.startsWith(KEPT));
function typeInto(vault: MockVault, from: string, to: string): void {
	const e = vault.files.get(ZEL_NOTE);
	if (!e) throw new Error("no note");
	assert.ok(e.content.includes(from), e.content);
	e.content = e.content.replace(from, to);
}

test("★ a known-of stub a view reset writes over a whole note the person typed into copies the note first", async () => {
	const s = await wholeZel();
	typeInto(s.vault, "Born in Krezk.", "Born in Krezk, typed into by a person.");
	await download(s.app, s.plugin, [upsert(stubOf(ZEL, "Zelraun", 5, { description: "A knight." }), 5), whole(IRE, "Ireena", 2)], 5, VIEW);
	const note = s.vault.contentAt(ZEL_NOTE) ?? "";
	assert.ok(note.includes(KNOWN_OF_LINE) && !note.includes("Born in Krezk"), note);
	const made = copies(s.vault);
	assert.equal(made.length, 1, `the stub replaced typed text with no copy: ${JSON.stringify(made)}`);
	assert.match(s.vault.contentAt(made[0]) ?? "", /typed into by a person/);
	assert.ok(__notices.some((n) => n.includes("could not tell were unedited") && n.includes('Character "Zelraun"')), __notices.join(" | "));
});

test("★ a hidden-by-owner stub written over a whole note the person typed into copies the note first", async () => {
	const s = await wholeZel();
	typeInto(s.vault, "Born in Krezk.", "Born in Krezk, typed into by a person.");
	await download(s.app, s.plugin, [hidden(ZEL, 3)], 3);
	const note = s.vault.contentAt(ZEL_NOTE) ?? "";
	assert.ok(note.includes(HIDDEN_STUB_LINE) && !note.includes("Born in Krezk"), note);
	const made = copies(s.vault);
	assert.equal(made.length, 1, `the stub replaced typed text with no copy: ${JSON.stringify(made)}`);
	assert.match(s.vault.contentAt(made[0]) ?? "", /typed into by a person/);
	assert.ok(__notices.some((n) => n.includes("could not tell were unedited") && n.includes('Character "Zelraun"')), __notices.join(" | "));
});

test("an untouched whole note turned into a stub, known of or hidden, is replaced with no copy", async () => {
	for (const turn of ["known of", "hidden"]) {
		const s = await wholeZel();
		if (turn === "hidden") await download(s.app, s.plugin, [hidden(ZEL, 3)], 3);
		else await download(s.app, s.plugin, [upsert(stubOf(ZEL, "Zelraun", 5, { description: "A knight." }), 5), whole(IRE, "Ireena", 2)], 5, VIEW);
		assert.deepEqual(copies(s.vault), [], `an untouched note made ${turn} was copied`);
	}
});

test("★ a stub rewritten as a stub is copied first when the person typed on it, by the same rule; an untouched one is not", async () => {
	const s = await wholeZel();
	await download(s.app, s.plugin, [upsert(stubOf(ZEL, "Zelraun", 5, { description: "A knight." }), 5), whole(IRE, "Ireena", 2)], 5, VIEW);
	// Untouched: known of again, no copy (the stub's write recorded its mark).
	await download(s.app, s.plugin, [upsert(stubOf(ZEL, "Zelraun", 6, { description: "A knight, older." }), 6)], 6);
	assert.deepEqual(copies(s.vault), [], "an untouched known-of note rewritten as known of was copied");
	// Typed on: known of again, copied first.
	typeInto(s.vault, `${KNOWN_OF_LINE}\n\n`, `${KNOWN_OF_LINE}\n\nMet him at the gate.\n\n`);
	await download(s.app, s.plugin, [upsert(stubOf(ZEL, "Zelraun", 7, { description: "A knight, older still." }), 7)], 7);
	assert.match(s.vault.contentAt(ZEL_NOTE) ?? "", /Met him at the gate\.[\s\S]*A knight, older still\./);
	assert.equal(copies(s.vault).length, 1, "a known-of note typed on was rewritten with no copy");
	assert.match(s.vault.contentAt(copies(s.vault)[0]) ?? "", /Met him at the gate\./);
});

test("★ a known-of note with a section of the person's, hidden by the world's owner, is copied first: the stub empties that section", async () => {
	const s = await wholeZel();
	await download(s.app, s.plugin, [upsert(stubOf(ZEL, "Zelraun", 5, { description: "A knight." }), 5), whole(IRE, "Ireena", 2)], 5, VIEW);
	const e = s.vault.files.get(ZEL_NOTE);
	assert.ok(e);
	e.content = `${e.content}\n### My notes\n\nHe owes me a horse.\n`;
	await download(s.app, s.plugin, [hidden(ZEL, 8)], 8);
	assert.ok((s.vault.contentAt(ZEL_NOTE) ?? "").includes(HIDDEN_STUB_LINE), s.vault.contentAt(ZEL_NOTE));
	const kept = copies(s.vault).map((p) => s.vault.contentAt(p) ?? "");
	assert.ok((s.vault.contentAt(ZEL_NOTE) ?? "").includes("He owes me a horse.") || kept.some((c) => c.includes("He owes me a horse.")),
		"the person's section is in neither the stub nor a copy");
	assert.equal(kept.length, 1, "a known-of note with the person's section was stubbed with no copy");
});

test("★ a hidden stub's write records the mark of its bytes: an untouched stub that comes back whole is no copy", async () => {
	const s = await wholeZel();
	await download(s.app, s.plugin, [hidden(ZEL, 3)], 3);
	await download(s.app, s.plugin, [whole(ZEL, "Zelraun", 4, { description: "A knight of Barovia." })], 4);
	assert.match(s.vault.contentAt(ZEL_NOTE) ?? "", /name: Zelraun[\s\S]*A knight of Barovia\./);
	assert.deepEqual(copies(s.vault), [], "the stub coming back whole was copied though nobody typed into it");
});
