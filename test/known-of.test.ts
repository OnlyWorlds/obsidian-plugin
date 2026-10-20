/**
 * OW Infra #454: known-of elements (the folder spec §4.4, rules 1 to 5; keel
 * PR 113 and PR 117). A guest's stub is written as it is, read as known of,
 * never pushed by any path; it is written whole when it arrives whole; a
 * whole note whose element arrives as a stub follows the reset that brought it.
 * The pure core first, then the real commands over the in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { CopyWorldCommand } from "../Commands/CopyWorldCommand";
import { PasteWorldCommand } from "../Commands/PasteWorldCommand";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { WorldService } from "../Scripts/WorldService";
import { AutoSyncEngine } from "../sync/auto-sync";
import { readElement } from "../vault/element-file";
import {
	KNOWN_OF_LINE,
	KNOWN_OF_NOT_SAVED,
	isKnownOfElement,
	isKnownOfNote,
	knownOfKept,
	knownOfKeptText,
	knownOfWrite,
	noteStateOf,
} from "../sync/known-of";
import { HIDDEN_STUB_LINE } from "../sync/hidden-on-server";
import { harnessSave } from "./support/save-harness";
import { harnessUpload } from "./support/upload-harness";

const WID = "019e0000-0000-7000-8000-0000000004ee";
const STRAHD = "019e0000-0000-7000-8000-0000000004c1";
const IRE = "019e0000-0000-7000-8000-0000000004c2";
const ZEL = "019e0000-0000-7000-8000-0000000004c3";

/** A Character as keel serves it known of: kept keys whole, every other field its unset value. */
function stubOf(id: string, name: string, seq: number, kept: Record<string, unknown> = {}) {
	return {
		type: "character", id, name, description: "", supertype: "", subtype: "", image_url: "",
		physicality: "", mentality: "", height: null, weight: null, species: [], traits: [], background: "",
		reputation: "", location: null, friends: [], charisma: null,
		created_by: null, changed_by: null, changed_via: null,
		created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z", change_seq: seq,
		...kept, known_of: true,
	};
}
const upsert = (element: Record<string, unknown>, seq: number) => ({
	op: "upsert", type: "character", id: element.id, change_seq: seq, updated_at: "x", element,
});
const whole = (id: string, name: string, seq: number, extra: Record<string, unknown> = {}) =>
	upsert({ type: "character", id, name, ...extra }, seq);
const STRAHD_STUB = (seq: number, extra: Record<string, unknown> = {}) =>
	stubOf(STRAHD, "Strahd", seq, { description: "The lord of Barovia.", supertype: "Vampire", physicality: "Pale.", ...extra });

// --- the pure core -------------------------------------------------------------

test("★ rule 1 core: a stub keeps every key whose value is set, whatever it is, and never `known_of`", () => {
	const kept = knownOfKept({ ...STRAHD_STUB(3), x_unexpected: "kept too", height: 0 });
	assert.equal(kept.name, "Strahd");
	assert.equal(kept.description, "The lord of Barovia.");
	assert.equal(kept.x_unexpected, "kept too", "a key the plugin does not know was dropped");
	assert.equal(kept.height, 0, "a zero is a value, not an unset field");
	for (const k of ["subtype", "image_url", "mentality", "weight", "species", "background", "location", "friends", "created_by", "known_of"]) {
		assert.ok(!(k in kept), `${k} was kept`);
	}
	assert.equal(isKnownOfElement(STRAHD_STUB(3)), true);
	assert.equal(isKnownOfElement({ id: STRAHD, name: "Strahd" }), false);
	assert.equal(isKnownOfElement({ id: STRAHD, known_of: "true" }), false, "only a JSON true marks a stub");
});

test("★ rules 4 and 5 core: what an arriving element does to each kind of note", () => {
	const stub = STRAHD_STUB(3);
	const full = { id: STRAHD, name: "Strahd" };
	for (const state of ["none", "whole", "known_of", "hidden_stub"] as const) {
		for (const resync of [null, "role", "view", "none"] as const) {
			assert.equal(knownOfWrite(full, state, resync), "whole", `whole over ${state} (${resync})`);
		}
	}
	for (const state of ["none", "known_of", "hidden_stub"] as const) {
		assert.equal(knownOfWrite(stub, state, null), "stub", `a stub over ${state}`);
	}
	assert.equal(knownOfWrite(stub, "whole", "view"), "stub", "a view reset: the stub replaces the whole copy");
	for (const resync of [null, "role", "none"] as const) {
		assert.equal(knownOfWrite(stub, "whole", resync), "keep", `a ${resync} reset keeps the whole copy`);
	}
});

test("rule 2 core: a note is known of by its key, or by its line under an element id", () => {
	const byKey = `---\nname: Strahd\nid: ${STRAHD}\nknown_of: true\n---\n\n### Description\n\nX.\n`;
	const byLine = `---\nname: Strahd\nid: ${STRAHD}\n---\n\n${KNOWN_OF_LINE}\n\n### Description\n\nX.\n`;
	const plain = `---\nname: Strahd\nid: ${STRAHD}\n---\n\n### Description\n\nX.\n`;
	const own = `---\ntags: [x]\n---\n\n${KNOWN_OF_LINE}\n`;
	assert.equal(isKnownOfNote(byKey), true);
	assert.equal(isKnownOfNote(byLine), true);
	assert.equal(isKnownOfNote(plain), false);
	assert.equal(isKnownOfNote(own), false, "a note with no element id is the person's own");
	assert.equal(isKnownOfNote(byKey.replace("known_of: true", "known_of: false")), false);
	assert.equal(noteStateOf(null), "none");
	assert.equal(noteStateOf(byKey), "known_of");
	assert.equal(noteStateOf(plain), "whole");
	assert.equal(noteStateOf(`---\nname:\nid: ${ZEL}\n---\n\n${HIDDEN_STUB_LINE}\n`), "hidden_stub");
	const kept = `---\nname: Strahd\nid: ${STRAHD}\nknown_of: true\n---\n\n${KNOWN_OF_LINE}\n\nMet him at the gate.\n\n### Description\n\nX.\n`;
	assert.equal(knownOfKeptText(kept), "Met him at the gate.\n\n");
	assert.equal(knownOfKeptText(byKey), "");
	assert.equal(knownOfKeptText(plain), "", "a whole note's text is its own fields, never carried");
});

// --- Download --------------------------------------------------------------------

type Settings = { syncCursors: Record<string, unknown>; [k: string]: unknown };

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

async function fresh() {
	const { app, vault: mock } = makeApp();
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	return { app, vault: app.vault, mock, plugin };
}

const KNOWN_NOTICE = "1 element is known of: its note shows only what you know, and edits to it stay in this vault.";
const KEPT_NOTICE = "1 element you knew in full is now known of: your note keeps what you had.";

test("★ rule 1: Download writes a stub as it is: `known_of: true`, its kept keys, no unset field, the line shown", async () => {
	const s = await fresh();
	const notices = await download(s.app, s.plugin, [whole(IRE, "Ireena", 1, { description: "A noble." }), upsert(STRAHD_STUB(2), 2)], 2);
	const note = await s.vault.read(noteOf(s.app, STRAHD));
	assert.ok(note.startsWith(`---\nname: Strahd\nid: ${STRAHD}\nknown_of: true\nsupertype: Vampire\n---\n`), note);
	for (const unset of ["subtype:", "image_url:", "height:", "weight:", "species:", "location:", "friends:", "charisma:", "x_", "### Background", "### Reputation", "### Mentality"]) {
		assert.ok(!note.includes(unset), `an unset field was written: ${unset}\n${note}`);
	}
	assert.ok(note.includes(`${KNOWN_OF_LINE}\n\n### Description\n\nThe lord of Barovia.\n`), note);
	assert.ok(note.includes("### Physicality\n\nPale.\n"), note);
	assert.ok(notices.includes(KNOWN_NOTICE), notices.join(" | "));
	// A whole element beside it is written whole, as ever.
	const ireena = await s.vault.read(noteOf(s.app, IRE));
	assert.ok(!ireena.includes("known_of") && ireena.includes("### Background"), ireena);
});

test("★ rule 2: the reader reads a known-of note as known of, its line no part of the description, `known_of` never adopted as a field", async () => {
	const s = await fresh();
	await download(s.app, s.plugin, [upsert(STRAHD_STUB(2), 2)], 2);
	const parsed = await readElement(s.app, noteOf(s.app, STRAHD));
	assert.ok(parsed);
	assert.equal(parsed.knownOf, true);
	assert.equal(parsed.fields.description, "The lord of Barovia.");
	assert.ok(!("x_known_of" in parsed.fields) && !("known_of" in parsed.fields), JSON.stringify(parsed.fields));
	assert.ok(!("background" in parsed.fields), "an unknown field was read as empty");
});

test("★ a stub arriving again rewrites the stub, keeps the person's writing under the line, and says nothing", async () => {
	const s = await fresh();
	await download(s.app, s.plugin, [upsert(STRAHD_STUB(2), 2)], 2);
	const file = noteOf(s.app, STRAHD);
	await s.vault.modify(file, (await s.vault.read(file)).replace(`${KNOWN_OF_LINE}\n\n`, `${KNOWN_OF_LINE}\n\nMet him at the gate.\n\n`));
	const notices = await download(s.app, s.plugin, [upsert(STRAHD_STUB(3, { description: "The lord of Barovia, ancient." }), 3)], 3);
	const note = await s.vault.read(noteOf(s.app, STRAHD));
	assert.ok(note.includes(`${KNOWN_OF_LINE}\n\nMet him at the gate.\n\n### Description\n\nThe lord of Barovia, ancient.\n`), note);
	assert.ok(!notices.some((n) => n.includes("known of")), notices.join(" | "));
});

test("★ rule 4: a stub that arrives whole is written whole; `known_of` and the line go, the person's writing stays", async () => {
	const s = await fresh();
	await download(s.app, s.plugin, [upsert(STRAHD_STUB(2), 2)], 2);
	const file = noteOf(s.app, STRAHD);
	await s.vault.modify(file, (await s.vault.read(file)).replace(`${KNOWN_OF_LINE}\n\n`, `${KNOWN_OF_LINE}\n\nMet him at the gate.\n\n`));
	await download(s.app, s.plugin, [whole(STRAHD, "Strahd", 3, { description: "The lord of Barovia.", background: "Cursed.", height: 190 })], 3);
	const note = await s.vault.read(noteOf(s.app, STRAHD));
	assert.ok(!note.includes("known_of") && !note.includes(KNOWN_OF_LINE), note);
	assert.ok(note.includes("height: 190") && note.includes("### Background\n\nCursed.\n"), note);
	assert.ok(note.includes("Met him at the gate.\n\n### Description"), note);
	assert.equal((await readElement(s.app, noteOf(s.app, STRAHD)))?.knownOf, false);
});

async function wholeZel() {
	const s = await fresh();
	await download(s.app, s.plugin, [
		whole(ZEL, "Zelraun", 1, { description: "A knight of Barovia.", background: "Born in Krezk.", height: 182, x_mood: "grim" }),
		whole(IRE, "Ireena", 2, { description: "A noble." }),
	], 2);
	const before = await s.vault.read(noteOf(s.app, ZEL));
	assert.ok(before.includes("Born in Krezk.") && before.includes("x_mood"), before);
	return { ...s, before };
}
const ZEL_STUB = (seq: number) => stubOf(ZEL, "Zelraun", seq, { description: "A knight." });

test("★ rule 5, view: after a view reset the stub replaces the whole copy", async () => {
	const s = await wholeZel();
	const notices = await download(s.app, s.plugin, [upsert(ZEL_STUB(5), 5), whole(IRE, "Ireena", 2)], 5, {
		error: { code: "resync_required", message: "Your view of this world changed.", reason: "view" },
	});
	const note = await s.vault.read(noteOf(s.app, ZEL));
	assert.ok(note.includes("known_of: true") && note.includes(KNOWN_OF_LINE) && note.includes("A knight."), note);
	for (const gone of ["Born in Krezk.", "height:", "x_mood", "### Background", "A knight of Barovia."]) {
		assert.ok(!note.includes(gone), `the whole copy's ${gone} stayed\n${note}`);
	}
	assert.ok(notices.includes(KNOWN_NOTICE), notices.join(" | "));
	assert.ok(!notices.some((n) => n.includes("left your view")), "a known-of element was counted as out of view");
});

test("★ rule 5, role or no reason: after the reset the whole copy is kept as last known, byte for byte, and said", async () => {
	for (const conflict of [
		{ error: { code: "resync_required", message: "m", reason: "role" } },
		{ error: { code: "resync_required", message: "m" } },
	]) {
		const s = await wholeZel();
		const notices = await download(s.app, s.plugin, [upsert(ZEL_STUB(5), 5), whole(IRE, "Ireena", 2)], 5, conflict);
		assert.equal(await s.vault.read(noteOf(s.app, ZEL)), s.before);
		assert.ok(notices.includes(KEPT_NOTICE), notices.join(" | "));
	}
});

test("★ rule 5, no reset: a stub in an ordinary pull keeps the whole copy as last known", async () => {
	const s = await wholeZel();
	const notices = await download(s.app, s.plugin, [upsert(ZEL_STUB(3), 3)], 3);
	assert.equal(await s.vault.read(noteOf(s.app, ZEL)), s.before);
	assert.ok(notices.includes(KEPT_NOTICE), notices.join(" | "));
});

// --- every push path ------------------------------------------------------------

const KNOWN = (id: string, name: string) =>
	`---\nname: ${name}\nid: ${id}\nknown_of: true\nsupertype: Vampire\n---\n\n${KNOWN_OF_LINE}\n\n### Description\n\nThe lord of Barovia, edited here.\n`;
const plain = (id: string, name: string, links = "") => `---\nname: ${name}\nid: ${id}\n${links}---\n\n### Description\n\nAbout ${name}.\n`;

test("★ rule 3, Save Element: a known-of note is never sent, on the server or not, deleted there or not", async () => {
	const servers: Record<string, Record<string, unknown>>[] = [{ [STRAHD]: { name: "Strahd", description: "The lord of Barovia.", known_of: true } }, {}];
	for (const server of servers) {
		const r = await harnessSave({ notes: { "Character/Strahd.md": KNOWN(STRAHD, "Strahd") }, save: "Character/Strahd.md", server });
		assert.equal(r.result.ok, false);
		assert.equal((r.result as { reason: string }).reason, KNOWN_OF_NOT_SAVED);
		assert.deepEqual(r.calls, [], r.calls.join(","));
		assert.deepEqual(r.sent, []);
		assert.ok(r.notices.includes(KNOWN_OF_NOT_SAVED), r.notices.join(" | "));
	}
	// The re-create after a 410, on the user's word: never reached.
	const gone = await harnessSave({ notes: { "Character/Strahd.md": KNOWN(STRAHD, "Strahd") }, save: "Character/Strahd.md", gone: [STRAHD] });
	assert.deepEqual(gone.calls, []);
	assert.deepEqual(gone.sent, []);
	// The key taken out by hand: the line still holds it back.
	const byLine = KNOWN(STRAHD, "Strahd").replace("known_of: true\n", "");
	const r = await harnessSave({ notes: { "Character/Strahd.md": byLine }, save: "Character/Strahd.md" });
	assert.deepEqual(r.calls, []);
	assert.deepEqual(r.sent, []);
});

test("★ rule 3, auto-sync: a known-of note is never sent, the status stays idle, and it is said once", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	const file = await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Strahd (auto).md", KNOWN(STRAHD, "Strahd"));
	const calls: string[] = [];
	const statuses: string[] = [];
	const client = new Proxy({}, { get: (_t, k) => async () => { calls.push(String(k)); return {}; } });
	const plugin = {
		settings: { apiKey: "", debounceMs: 5, autoSync: true },
		setSyncStatus: (st: string) => statuses.push(st),
		buildV2Client: async () => client,
	};
	const engine = new AutoSyncEngine(app, plugin as never);
	const schedule = () => (engine as unknown as { scheduleSync(f: unknown): void }).scheduleSync(file);
	__notices.length = 0;
	schedule();
	await new Promise((r) => setTimeout(r, 60));
	schedule();
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(calls, []);
	assert.equal(statuses.at(-1), "idle");
	assert.ok(!statuses.includes("error"), statuses.join(","));
	assert.equal(__notices.filter((n) => n === KNOWN_OF_NOT_SAVED).length, 1, __notices.join(" | "));
});

test("★ rule 3, the create-first walk: a known-of link target is never created, and the link still travels", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": plain(IRE, "Ireena", `friends:\n  - "[[Strahd]]"\n`),
			"Character/Strahd.md": KNOWN(STRAHD, "Strahd"),
		},
		save: "Character/Ireena.md",
		server: { [IRE]: { name: "Ireena", description: "About Ireena.", friends: [] } },
	});
	assert.ok(!r.calls.includes("bulk") && !r.calls.some((c) => c.startsWith("create")), r.calls.join(","));
	assert.ok(!r.sent.some((b) => b.id === STRAHD), "the known-of note was created");
});

test("★ rule 3, Upload World: a known-of note is never created or updated; links to it are kept; it is counted", async () => {
	const NEW = "019e0000-0000-7000-8000-0000000004c9";
	const r = await harnessUpload({
		notes: {
			"Character/Strahd.md": KNOWN(STRAHD, "Strahd"),
			"Character/Kasimir.md": KNOWN(NEW, "Kasimir"),
			"Character/Ireena.md": plain(IRE, "Ireena", `friends:\n  - "[[Strahd]]"\n`),
		},
		changes: [whole(IRE, "Ireena", 1), upsert(STRAHD_STUB(2), 2)],
		answer: true,
	});
	assert.ok(!(STRAHD in r.patches), "the known-of note was sent as an update");
	assert.ok(!r.bulkSent.some((e) => e.id === STRAHD || e.id === NEW), "a known-of note was created");
	assert.deepEqual(r.patches[IRE]?.friends, [STRAHD], JSON.stringify(r.patches[IRE]));
	assert.ok(r.notices.some((n) => n.includes("2 known-of notes were not sent")), r.notices.join(" | "));
});

// --- the other writers and readers -------------------------------------------------

const FOLDER_WID = "0199c000-0000-7000-8000-0000000004ee";

test("★ rule 1, the folder export: a known-of note is written with `known_of: true` and only its keys", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n- **Name:** W\n");
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Strahd.md", KNOWN(STRAHD, "Strahd"));
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Ireena.md", plain(IRE, "Ireena"));
	const plan = await (new ExportFolderCommand(app as never) as unknown as { planFiles(w: string, id: string): Promise<{ files: { rel: string; content: string }[] }> }).planFiles("W", FOLDER_WID);
	const bodies = plan.files.filter((f) => f.rel.startsWith("elements/")).map((f) => JSON.parse(f.content) as Record<string, unknown>);
	const strahd = bodies.find((b) => b.id === STRAHD);
	const ireena = bodies.find((b) => b.id === IRE);
	assert.ok(strahd && ireena);
	assert.equal(strahd.known_of, true);
	assert.equal(strahd.supertype, "Vampire");
	assert.equal(strahd.description, "The lord of Barovia, edited here.");
	for (const unset of ["subtype", "height", "species", "background", "location"]) assert.ok(!(unset in strahd), `${unset} written for a stub`);
	assert.ok(!("known_of" in ireena) && "background" in ireena, "a whole element changed shape");
});

test("★ rule 2, the folder import: a `known_of` file becomes a known-of note, never a whole one", async () => {
	const { app, vault } = makeApp();
	await vault.seed("in/b/world.json", JSON.stringify({ id: FOLDER_WID, name: "Barovia" }));
	await vault.seed("in/b/elements/character/strahd.json", JSON.stringify({ type: "character", id: STRAHD, name: "Strahd", description: "The lord.", known_of: true }));
	await (new ImportFolderCommand(app) as unknown as { importFolder(d: string): Promise<void> }).importFolder("in/b");
	const note = await app.vault.read(noteOf(app, STRAHD));
	assert.ok(note.includes("known_of: true") && note.includes(KNOWN_OF_LINE), note);
	assert.ok(!note.includes("### Background") && !note.includes("height:"), note);
});

test("★ Copy World carries a known-of note as a stub, and Paste World writes it back as one", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n- **Name:** W\n");
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Strahd.md", KNOWN(STRAHD, "Strahd"));
	const data = (await new CopyWorldCommand(app, {} as never, new WorldService(app)).collectWorldData("OnlyWorlds/Worlds/W")) as Record<string, Record<string, unknown>[]>;
	const copied = data.Character.find((e) => e.id === STRAHD);
	assert.ok(copied);
	assert.equal(copied.known_of, true);
	assert.ok(!("background" in copied), JSON.stringify(copied));

	const target = makeApp();
	await target.vault.seed("OnlyWorlds/Worlds/P/World.md", "- **Name:** P\n");
	await new PasteWorldCommand(target.app, {} as never).generateElementNotes("OnlyWorlds/Worlds/P/Elements", { Character: [copied] }, false);
	const note = await target.app.vault.read(noteOf(target.app, STRAHD));
	assert.ok(note.includes("known_of: true") && note.includes(KNOWN_OF_LINE) && !note.includes("### Background"), note);
});

test("Update World Format leaves a known-of note alone: its missing fields are unknown, not to scaffold", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/Elements/Character/Strahd.md", KNOWN(STRAHD, "Strahd"));
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<{ notes: { path: string }[] }> };
	const plan = await cmd.buildPlan("W");
	assert.deepEqual(plan.notes.map((n) => n.path), []);
});
