/**
 * The edges of a pull's copy before replace: the copies in Kept edits/ are no element notes of the world's (a stored cursor
 * over a folder that holds only copies is stale), a pull stopped by a copy it could not write says so in words and keeps the
 * numbers and marks of the notes it did write, and the copied notice names only notes the write reached.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import type { MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { markKey, noteMark } from "../vault/note-mark-core";

const WID = "019e0000-0000-7000-8000-0000000005ee";
const IRE = "019e0000-0000-7000-8000-0000000005c1";
const KOL = "019e0000-0000-7000-8000-0000000005c2";
const W = "OnlyWorlds/Worlds/Barovia";
const SEQ = `${W}/.ow-seq.json`;
const KEPT = `${W}/Kept edits/`;
const IRE_NOTE = `${W}/Elements/Character/Ireena.md`;
const KOL_NOTE = `${W}/Elements/Character/Kolyan.md`;

type Settings = { syncCursors: Record<string, { cursor: string; head: number }>; [k: string]: unknown };
type Vaultish = { process(f: unknown, fn: (d: string) => string): Promise<string>; create(p: string, c: string): Promise<unknown> };

const whole = (id: string, name: string, seq: number, description: string) => ({
	op: "upsert", type: "character", id, change_seq: seq, updated_at: "x", element: { type: "character", id, name, description, change_seq: seq },
});

/** One Download over the feed `changes` at `head`; a walk from a cursor gets only `since` (none: nothing changed). */
async function download(app: App, plugin: { settings: Settings; saveSettings(): Promise<void> }, changes: unknown[], head: number, since: unknown[] = changes) {
	setRequestUrl((r) => {
		const url = new URL(r.url);
		const path = url.pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") {
			const from = url.searchParams.get("since");
			return { status: 200, json: { cursor: `c${head}`, has_more: false, head, changes: from ? since : changes } };
		}
		return { status: 404, json: {} };
	});
	__notices.length = 0;
	const landed = await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
	return { landed, notices: [...__notices] };
}

function fresh() {
	const { app, vault } = makeApp();
	const plugin = { settings: { syncCursors: {} } as Settings, saveSettings: async () => {} };
	return { app, vault, plugin };
}
const index = (vault: MockVault): Record<string, number> => JSON.parse(vault.dotfiles.get(SEQ) ?? "{}");
function typeInto(vault: MockVault, path: string, text: string): void {
	const e = vault.files.get(path);
	if (!e) throw new Error(`no note at ${path}`);
	e.content = e.content.replace("### Description\n\n", `### Description\n\n${text} `);
}

test("★ D1: a stored cursor over a world folder that holds only Kept edits/ copies is stale: the pull walks from the start", async () => {
	const s = fresh();
	await s.vault.seed(`${W}/World.md`, "# World Overview: Barovia\n\n- **API Key:** ow_k_test\n");
	await s.vault.seed(`${KEPT}Ireena (kept 2026-11-26 2006).md`, `---\nname: Ireena\nkept_from: ${IRE}\n---\n\n### Description\n\nTyped once.\n`);
	s.plugin.settings.syncCursors[WID] = { cursor: "c4", head: 4 };
	await download(s.app, s.plugin, [whole(IRE, "Ireena", 4, "A noble.")], 4, []);
	assert.match(s.vault.contentAt(IRE_NOTE) ?? "", /A noble\./, "the pull took the copy for an element note and trusted the cursor: nothing was written");
});

test("★ D2: a pull stopped by a copy it could not write names the note, says it was not changed, keeps the numbers and marks of the notes it wrote, and keeps the cursor", async () => {
	const s = fresh();
	await download(s.app, s.plugin, [whole(IRE, "Ireena", 1, "A noble."), whole(KOL, "Kolyan", 2, "A priest.")], 2);
	assert.equal(s.plugin.settings.syncCursors[WID]?.cursor, "c2");
	typeInto(s.vault, KOL_NOTE, "Typed by a person.");
	const typed = s.vault.contentAt(KOL_NOTE);
	const v = s.app.vault as unknown as Vaultish;
	const create = v.create.bind(v);
	v.create = async (p, c) => {
		if (p.startsWith(KEPT)) throw new Error("the disk is full");
		return create(p, c);
	};
	const changes = [whole(IRE, "Ireena", 3, "Noble, changed."), whole(KOL, "Kolyan", 4, "Priest, changed.")];
	const r = await download(s.app, s.plugin, changes, 4);
	assert.equal(s.vault.contentAt(KOL_NOTE), typed, "the note whose copy failed was changed");
	assert.match(s.vault.contentAt(IRE_NOTE) ?? "", /Noble, changed\./);
	assert.equal(index(s.vault)[IRE], 3, "the number of the note the pull wrote was not recorded: its next save would be refused as stale");
	assert.equal(index(s.vault)[markKey(IRE)], noteMark(s.vault.contentAt(IRE_NOTE) ?? ""), "the mark of the note the pull wrote was not recorded");
	assert.equal(index(s.vault)[KOL], 2, "the number of the note left unchanged moved");
	assert.equal(s.plugin.settings.syncCursors[WID]?.cursor, "c2", "the cursor moved past a change no note took");
	const said = r.notices.find((n) => n.includes('Character "Kolyan"')) ?? "";
	assert.ok(said, r.notices.join(" | "));
	assert.doesNotMatch(said, /^Error fetching world data/, "the notice is the generic fetch error");
	assert.match(said, /^Download stopped/, said);
	assert.match(said, /not changed/, said);
	assert.match(said, /the disk is full/, said);
	assert.equal(r.landed, "Barovia", "a pull that wrote notes into the world's folder reports that nothing landed (a new key would be revoked)");
	// The next pull, with the folder writable again, copies the typed note and finishes.
	v.create = create;
	const again = await download(s.app, s.plugin, changes, 4);
	assert.match(s.vault.contentAt(KOL_NOTE) ?? "", /Priest, changed\./, again.notices.join(" | "));
	assert.equal(s.plugin.settings.syncCursors[WID]?.cursor, "c4");
});

const ISM = "019e0000-0000-7000-8000-0000000005c3";

test("★ a pull stopped by an ordinary write error on the second note of three keeps the first note's number and mark, and holds the cursor", async () => {
	const s = fresh();
	await download(s.app, s.plugin, [whole(IRE, "Ireena", 1, "A noble."), whole(KOL, "Kolyan", 2, "A priest."), whole(ISM, "Ismark", 3, "A brother.")], 3);
	const v = s.app.vault as unknown as Vaultish;
	const process = v.process.bind(v);
	v.process = async (f, fn) => {
		if ((f as { path: string }).path === KOL_NOTE) throw new Error("the disk is full");
		return process(f, fn);
	};
	const r = await download(s.app, s.plugin, [whole(IRE, "Ireena", 4, "Noble, changed."), whole(KOL, "Kolyan", 5, "Priest, changed."), whole(ISM, "Ismark", 6, "Brother, changed.")], 6);
	assert.match(s.vault.contentAt(IRE_NOTE) ?? "", /Noble, changed\./);
	assert.equal(index(s.vault)[IRE], 4, "the number of the note the pull wrote was not recorded: its next save would be refused as stale");
	assert.equal(index(s.vault)[markKey(IRE)], noteMark(s.vault.contentAt(IRE_NOTE) ?? ""));
	assert.equal(index(s.vault)[KOL], 2, "the number of the note whose write failed moved");
	assert.equal(index(s.vault)[ISM], 3, "the number of a note the pull never reached moved");
	assert.doesNotMatch(s.vault.contentAt(`${W}/Elements/Character/Ismark.md`) ?? "", /Brother, changed\./, "the pull went on past the failed write");
	assert.equal(s.plugin.settings.syncCursors[WID]?.cursor, "c3", "the cursor moved past changes no note took");
	const said = r.notices.find((n) => n.includes('Character "Kolyan"')) ?? "";
	assert.match(said, /^Download stopped/, r.notices.join(" | "));
	assert.match(said, /the disk is full/, said);
	assert.equal(r.landed, "Barovia", "a pull that wrote notes into the world's folder reports that nothing landed (a new key would be revoked)");
});

test("★ a hidden stub whose write throws holds the cursor and says so: the note stays whole until the next pull", async () => {
	const s = fresh();
	await download(s.app, s.plugin, [whole(IRE, "Ireena", 1, "A noble.")], 1);
	const v = s.app.vault as unknown as Vaultish;
	const process = v.process.bind(v);
	v.process = async (f, fn) => {
		if ((f as { path: string }).path === IRE_NOTE) throw new Error("the disk is full");
		return process(f, fn);
	};
	const r = await download(s.app, s.plugin, [{ op: "delete", type: "character", id: IRE, change_seq: 2, updated_at: "x", reason: "hidden" }], 2);
	assert.match(s.vault.contentAt(IRE_NOTE) ?? "", /A noble\./);
	assert.equal(s.plugin.settings.syncCursors[WID]?.cursor, "c1", "the cursor moved past a hidden row whose stub was never written");
	assert.ok(r.notices.some((n) => n.includes('Character "Ireena"') && /^Download stopped/.test(n)), r.notices.join(" | "));
	assert.equal(r.landed, "Barovia");
});

test("★ D3: the copied notice names only notes the write reached: a copy whose write then failed is not named", async () => {
	const s = fresh();
	await download(s.app, s.plugin, [whole(IRE, "Ireena", 1, "A noble."), whole(KOL, "Kolyan", 2, "A priest.")], 2);
	typeInto(s.vault, IRE_NOTE, "Typed into Ireena.");
	typeInto(s.vault, KOL_NOTE, "Typed into Kolyan.");
	const v = s.app.vault as unknown as Vaultish;
	const process = v.process.bind(v);
	v.process = async (f, fn) => {
		if ((f as { path: string }).path === KOL_NOTE) throw new Error("the disk is full");
		return process(f, fn);
	};
	await download(s.app, s.plugin, [whole(IRE, "Ireena", 3, "Noble, changed."), whole(KOL, "Kolyan", 4, "Priest, changed.")], 4);
	const notice = __notices.find((n) => n.includes("could not tell were unedited")) ?? "";
	assert.match(notice, /Character "Ireena"/, __notices.join(" | "));
	assert.doesNotMatch(notice, /Kolyan/, "the notice names a note the write never reached");
	assert.match(s.vault.contentAt(KOL_NOTE) ?? "", /Typed into Kolyan\./);
});

test("★ D3: a note copied then left as the person has it (it changed under each try) is not named as copied", async () => {
	const s = fresh();
	await download(s.app, s.plugin, [whole(IRE, "Ireena", 1, "A noble.")], 1);
	let n = 0;
	s.vault.beforeProcess = (f) => {
		if (f.path === IRE_NOTE) typeInto(s.vault, IRE_NOTE, `Typing ${++n}.`);
	};
	const r = await download(s.app, s.plugin, [whole(IRE, "Ireena", 2, "Noble, changed.")], 2);
	assert.equal(n, 3);
	assert.ok(!r.notices.some((x) => x.includes("could not tell were unedited")), r.notices.join(" | "));
	assert.ok(r.notices.some((x) => x.includes("did not write")), r.notices.join(" | "));
});
