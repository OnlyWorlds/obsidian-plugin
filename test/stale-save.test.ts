/**
 * A stale save is refused, never reverts another writer's change (3.8.1,
 * OW Obsidian #557, Fix 1; Boss's walk D1 claim 1 on keel staging: a note
 * pulled with description "A", another writer's "B", a name-only edit in the
 * stale note sent {name, description: "A"} and the PATCH answered 200 with
 * "B" reverted; the same PATCH with If-Match the pulled change_seq answered
 * 412 precondition_failed and wrote nothing).
 *
 * The REAL Save element, Delete element and Download over the in-memory vault
 * and the REAL v2 client, its requestUrl answered by a small keel: GET, PATCH
 * (If-Match checked as keel's elements/api.py _expect_seq does: quoted or
 * bare, 412 with the live element as `current`), POST, DELETE, /changes.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, setRequestUrl, __notices, __modals, __requests, type MockRequest, type MockVault } from "./support/obsidian-mock";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { DeleteElementCommand } from "../Commands/DeleteElementCommand";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { V2Client } from "../client-v2";

const WID = "019e0000-0000-7000-8000-0000000005e7";
const W = "OnlyWorlds/Worlds/W";
const SEQ_FILE = `${W}/.ow-seq.json`;
const STALE = "changed on onlyworlds.com since this note was pulled";

const note = (id: string, name: string, description: string) =>
	`---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\n${description}\n`;

/** A small keel: elements by id, a head, and what another writer does. */
class Keel {
	els = new Map<string, Record<string, unknown>>();
	head = 0;
	/** Run once just before the next PATCH is applied (another writer, between the read and the write). */
	beforePatch: (() => void) | null = null;
	/** keel does not read If-Match on DELETE today; set to emulate a keel that does. */
	deleteChecksIfMatch = false;
	put(id: string, fields: Record<string, unknown>, seq?: number): void {
		this.head = Math.max(this.head + 1, seq ?? 0);
		this.els.set(id, { type: "character", id, ...fields, change_seq: seq ?? this.head });
	}
	/** Another writer's PATCH: no If-Match, the server moves on. */
	otherWriter(id: string, fields: Record<string, unknown>): void {
		const el = this.els.get(id)!;
		this.els.set(id, { ...el, ...fields, change_seq: ++this.head });
	}
	private expect(r: MockRequest): number | null {
		const raw = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "if-match")?.[1];
		if (raw === undefined) return null;
		const m = /^(?:W\/)?"?(\d+)"?$/.exec(raw.trim());
		if (!m) throw new Error(`If-Match not a change_seq: ${raw}`);
		return Number(m[1]);
	}
	handle = (r: MockRequest) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "W" } };
		if (path === "/changes") {
			const changes = [...this.els.values()].map((e) => ({ op: "upsert", type: "character", id: e.id, change_seq: e.change_seq, updated_at: "x", element: e }));
			return { status: 200, json: { cursor: "c1", has_more: false, head: this.head, changes } };
		}
		const m = /^\/character\/([0-9a-f-]+)$/.exec(path);
		if (m) {
			const id = m[1];
			const el = this.els.get(id);
			if (r.method === "GET") return el ? { status: 200, json: el } : { status: 404, json: { error: { code: "not_found", message: "Not found." } } };
			if (r.method === "PATCH") {
				if (!el) return { status: 404, json: { error: { code: "not_found", message: "Not found." } } };
				this.beforePatch?.();
				this.beforePatch = null;
				const live = this.els.get(id)!;
				const expect = this.expect(r);
				if (expect !== null && expect !== live.change_seq) {
					return { status: 412, json: { error: { code: "precondition_failed", message: `The element has changed since change_seq ${expect} (now ${String(live.change_seq)}).`, param: "If-Match" }, current: live } };
				}
				const next = { ...live, ...(JSON.parse(r.body ?? "{}") as Record<string, unknown>), change_seq: ++this.head };
				this.els.set(id, next);
				return { status: 200, json: next };
			}
			if (r.method === "DELETE") {
				const expect = this.expect(r);
				if (this.deleteChecksIfMatch && el && expect !== null && expect !== el.change_seq) {
					return { status: 412, json: { error: { code: "precondition_failed", message: "moved" }, current: el } };
				}
				this.els.delete(id);
				this.head++;
				return { status: 204, text: "" };
			}
		}
		if (path === "/character" && r.method === "POST") {
			const b = JSON.parse(r.body ?? "{}") as Record<string, unknown>;
			this.put(String(b.id), b);
			return { status: 201, json: this.els.get(String(b.id)) };
		}
		return { status: 404, json: { error: { code: "not_found", message: "Not found." } } };
	};
}

async function setup(seqs?: Record<string, number>) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "- **API Key:** ow_k_test\n");
	if (seqs) await vault.adapter.write(SEQ_FILE, JSON.stringify(seqs));
	const keel = new Keel();
	setRequestUrl(keel.handle);
	const plugin = {
		settings: { apiKey: "", deletedOnServer: {}, hiddenOnServer: {}, leftView: {}, lastKnown: {}, syncCursors: {} as Record<string, unknown>, knownOnServer: {} },
		saveSettings: async () => {},
		buildV2Client: async () => new V2Client("ow_k_test", "1234"),
		manifest: { id: "onlyworlds-builder", version: "3.8.1" },
	};
	return { app, vault, keel, plugin };
}

async function save(app: App, plugin: unknown, file: TFile, manual = true) {
	__notices.length = 0;
	const result = await new SaveElementCommand(app, plugin as never).execute(file, { manual });
	return { result, notices: [...__notices] };
}

const seqIndex = (vault: MockVault): Record<string, number> => JSON.parse(vault.dotfiles.get(SEQ_FILE) ?? "{}");
const writes = () => __requests.filter((r) => r.method !== "GET");
const ifMatchOf = (r: MockRequest) => r.headers["If-Match"];

test("★ a save whose note was pulled at the server's change_seq goes through with If-Match, and records the answer's", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a1";
	const { app, vault, keel, plugin } = await setup({ [ID]: 44 });
	keel.put(ID, { name: "Hero", description: "A" }, 44);
	const file = (await vault.seed(`${W}/Elements/Character/Hero.md`, note(ID, "Hero", "A, edited"))) as unknown as TFile;
	const { result } = await save(app, plugin, file);
	assert.deepEqual(result, { ok: true, outcome: "updated" });
	const patch = writes().find((r) => r.method === "PATCH");
	assert.ok(patch, "no PATCH sent");
	assert.equal(ifMatchOf(patch), '"44"');
	assert.equal(keel.els.get(ID)!.description, "A, edited");
	assert.equal(seqIndex(vault)[ID], keel.els.get(ID)!.change_seq, "the answer's change_seq is recorded for the next save");
	assert.equal(seqIndex(vault)[ID], 45);
});

test("★ D1 claim 1: a save from a note pulled before another writer's change writes nothing, keeps the other writer's value, and says so once", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a2";
	const { app, vault, keel, plugin } = await setup({ [ID]: 44 });
	keel.put(ID, { name: "Hero", description: "A" }, 44);
	keel.otherWriter(ID, { description: "B" }); // now 45
	// The person edits only the name in the stale note (Boss's step 3).
	const content = note(ID, "Hero the Bold", "A");
	const file = (await vault.seed(`${W}/Elements/Character/Hero.md`, content)) as unknown as TFile;
	const { result, notices } = await save(app, plugin, file);
	assert.equal(result.ok, false);
	assert.deepEqual(writes(), [], "nothing is written to onlyworlds.com");
	assert.equal(keel.els.get(ID)!.description, "B", "the other writer's change is kept");
	assert.equal(keel.els.get(ID)!.name, "Hero");
	assert.equal(notices.filter((n) => n.includes(STALE)).length, 1, `one notice: ${JSON.stringify(notices)}`);
	assert.match(notices.find((n) => n.includes(STALE))!, /Download world brings the current copy/);
	assert.equal(vault.contentAt(`${W}/Elements/Character/Hero.md`), content, "the person's edit stays in the note, untouched");
	assert.equal(seqIndex(vault)[ID], 44, "no silent re-pull: the note is still at 44");
});

test("★ a 412 between the read and the PATCH writes nothing and shows the one notice", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a3";
	const { app, vault, keel, plugin } = await setup({ [ID]: 44 });
	keel.put(ID, { name: "Hero", description: "A" }, 44);
	keel.beforePatch = () => keel.otherWriter(ID, { description: "B" });
	const file = (await vault.seed(`${W}/Elements/Character/Hero.md`, note(ID, "Hero the Bold", "A"))) as unknown as TFile;
	const { result, notices } = await save(app, plugin, file);
	assert.equal(result.ok, false);
	const patch = writes().find((r) => r.method === "PATCH");
	assert.equal(patch && ifMatchOf(patch), '"44"', "the PATCH carried the pulled change_seq");
	assert.equal(keel.els.get(ID)!.description, "B");
	assert.equal(keel.els.get(ID)!.name, "Hero", "nothing of the stale save landed");
	assert.equal(notices.filter((n) => n.includes(STALE)).length, 1, JSON.stringify(notices));
	assert.equal(writes().length, 1, "no retry");
	assert.equal(seqIndex(vault)[ID], 44);
});

test("★ a note with no recorded change_seq (a vault from before 3.8.1) saves once without If-Match, and the next save is guarded", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a4";
	const { app, vault, keel, plugin } = await setup();
	keel.put(ID, { name: "Hero", description: "A" }, 44);
	const path = `${W}/Elements/Character/Hero.md`;
	const file = (await vault.seed(path, note(ID, "Hero", "A, edited"))) as unknown as TFile;
	assert.equal((await save(app, plugin, file)).result.ok, true);
	const first = writes().find((r) => r.method === "PATCH")!;
	assert.equal(ifMatchOf(first), undefined, "no If-Match on the first save");
	assert.equal(seqIndex(vault)[ID], 45, "the answer's change_seq is recorded");

	// Another writer, then a second edit here: guarded now.
	keel.otherWriter(ID, { description: "B" });
	vault.files.get(path)!.content = note(ID, "Hero", "A, edited twice");
	setRequestUrl(keel.handle);
	const { result, notices } = await save(app, plugin, file);
	assert.equal(result.ok, false);
	assert.deepEqual(writes(), []);
	assert.equal(keel.els.get(ID)!.description, "B");
	assert.equal(notices.filter((n) => n.includes(STALE)).length, 1);
});

test("a note never saved (made in the vault) is created, and its next save is guarded", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a5";
	const { app, vault, keel, plugin } = await setup();
	const path = `${W}/Elements/Character/New.md`;
	const file = (await vault.seed(path, note(ID, "New", "Fresh."))) as unknown as TFile;
	assert.deepEqual((await save(app, plugin, file)).result, { ok: true, outcome: "created" });
	assert.equal(seqIndex(vault)[ID], keel.els.get(ID)!.change_seq);
	vault.files.get(path)!.content = note(ID, "New", "Fresh, edited.");
	setRequestUrl(keel.handle);
	await save(app, plugin, file);
	assert.equal(ifMatchOf(writes().find((r) => r.method === "PATCH")!), `"${String(seqIndex(vault)[ID] - 1)}"`);
});

test("a note equal to the server's copy is current: Save records the server's change_seq and sends nothing", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a6";
	const { app, vault, keel, plugin } = await setup({ [ID]: 3 });
	keel.put(ID, { name: "Hero", description: "B" }, 9);
	const file = (await vault.seed(`${W}/Elements/Character/Hero.md`, note(ID, "Hero", "B"))) as unknown as TFile;
	assert.deepEqual((await save(app, plugin, file)).result, { ok: true, outcome: "unchanged" });
	assert.deepEqual(writes(), []);
	assert.equal(seqIndex(vault)[ID], 9);
});

test("★ auto-sync goes through the same path: a stale note's notice shows once per element per session, not at every pause", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a7";
	const { app, vault, keel, plugin } = await setup({ [ID]: 44 });
	keel.put(ID, { name: "Hero", description: "A" }, 44);
	keel.otherWriter(ID, { description: "B" });
	const path = `${W}/Elements/Character/Hero.md`;
	const file = (await vault.seed(path, note(ID, "Hero", "A, e"))) as unknown as TFile;
	const shown: string[] = [];
	for (const text of ["A, ed", "A, edi", "A, edit"]) {
		vault.files.get(path)!.content = note(ID, "Hero", text);
		const { result, notices } = await save(app, plugin, file, false);
		assert.equal(result.ok, false, "auto-sync's status must not read synced");
		assert.match((result as { reason: string }).reason, new RegExp(STALE));
		shown.push(...notices.filter((n) => n.includes(STALE)));
	}
	assert.equal(shown.length, 1, `one notice for three pauses: ${JSON.stringify(shown)}`);
	assert.equal(__requests.filter((r) => r.method === "PATCH").length, 0);
	assert.equal(keel.els.get(ID)!.description, "B");
	// The manual Save says it each time it is asked.
	assert.equal((await save(app, plugin, file, true)).notices.filter((n) => n.includes(STALE)).length, 1);
});

/** Run Delete element on `file` through its typed-name dialog. */
async function deleteNote(app: App, plugin: unknown, file: TFile) {
	(app as unknown as { workspace: { getActiveFile: () => TFile } }).workspace.getActiveFile = () => file;
	(app as unknown as { fileManager: { trashFile: (f: TFile) => Promise<void> } }).fileManager.trashFile = async (f: TFile) => {
		(app.vault as unknown as MockVault).files.delete(f.path);
	};
	__notices.length = 0;
	__modals.length = 0;
	await new DeleteElementCommand(app, plugin as never).execute();
	const modal = __modals.find((m) => m.constructor.name === "DeleteConfirmModal") as unknown as { onConfirm: () => Promise<void> | void };
	assert.ok(modal, "no delete dialog");
	await modal.onConfirm();
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	return [...__notices];
}

test("★ the delete path sends If-Match with the note's change_seq too", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a8";
	const { app, vault, keel, plugin } = await setup({ [ID]: 44 });
	keel.put(ID, { name: "Hero", description: "A" }, 44);
	const file = (await vault.seed(`${W}/Elements/Character/Hero.md`, note(ID, "Hero", "A"))) as unknown as TFile;
	await deleteNote(app, plugin, file);
	const del = __requests.find((r) => r.method === "DELETE");
	assert.ok(del, "no DELETE sent");
	assert.equal(ifMatchOf(del), '"44"');
	assert.equal(ID in seqIndex(vault), false, "a deleted element's entry goes");
});

test("a delete keel refuses with 412 keeps the note and says why", async () => {
	const ID = "019e0000-0000-7000-8000-0000000005a9";
	const { app, vault, keel, plugin } = await setup({ [ID]: 44 });
	keel.deleteChecksIfMatch = true;
	keel.put(ID, { name: "Hero", description: "A" }, 44);
	keel.otherWriter(ID, { description: "B" });
	const path = `${W}/Elements/Character/Hero.md`;
	const file = (await vault.seed(path, note(ID, "Hero", "A"))) as unknown as TFile;
	const notices = await deleteNote(app, plugin, file);
	assert.ok(keel.els.has(ID), "nothing deleted");
	assert.ok(vault.files.has(path), "the note stays");
	assert.ok(notices.some((n) => n.includes("so it was not deleted")), JSON.stringify(notices));
});

test("★ Download records each written note's change_seq beside the world, and the next save sends it", async () => {
	const A = "019e0000-0000-7000-8000-0000000005b1";
	const B = "019e0000-0000-7000-8000-0000000005b2";
	const { app, vault, keel, plugin } = await setup();
	keel.put(A, { name: "Alpha", description: "a" }, 3);
	keel.put(B, { name: "Beta", description: "b" }, 7);
	await new DownloadWorldCommand(app, plugin.manifest, plugin as never).downloadWithKey("ow_k_test", "");
	assert.deepEqual(seqIndex(vault), { [A]: 3, [B]: 7 });
	const notePath = [...vault.files.keys()].find((p) => p.startsWith(`${W}/Elements/`) && p.endsWith("/Beta.md"))!;
	assert.ok(notePath, "no note for Beta");
	assert.ok(!/change_seq/.test(vault.contentAt(notePath) ?? ""), "change_seq never enters the note (keel 422s it in a write body)");
	const before = vault.contentAt(notePath) ?? "";
	vault.files.get(notePath)!.content = before.replace("### Description\n\nb\n", "### Description\n\nb, edited\n");
	assert.notEqual(vault.contentAt(notePath), before, "the edit did not land in the note");
	setRequestUrl(keel.handle);
	const { result } = await save(app, plugin, vault.files.get(notePath)!.file as unknown as TFile);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(ifMatchOf(writes().find((r) => r.method === "PATCH")!), '"7"');
});

test("the v2 client sends If-Match only for a whole change_seq, quoted", async () => {
	setRequestUrl(() => ({ status: 200, json: { change_seq: 2 } }));
	const c = new V2Client("ow_k_test", "1234");
	await c.update("character", "x", { name: "n" }, { ifMatch: 41 });
	await c.update("character", "x", { name: "n" });
	await c.update("character", "x", { name: "n" }, { ifMatch: null });
	await c.deleteElement("character", "x", { ifMatch: 0 });
	assert.deepEqual(__requests.map((r) => r.headers["If-Match"]), ['"41"', undefined, undefined, '"0"']);
	assert.equal(__requests[1].headers["API-Key"], "ow_k_test", "the other headers stay");
});

test("★ Upload world: each PATCH carries its note's change_seq; a 412 is named, not reverted, not a failure; the answers' change_seqs are recorded", async () => {
	const { harnessUpload } = await import("./support/upload-harness");
	const CUR = "019e0000-0000-7000-8000-0000000005c1";
	const OLD = "019e0000-0000-7000-8000-0000000005c2";
	const NEW = "019e0000-0000-7000-8000-0000000005c3";
	const NONE = "019e0000-0000-7000-8000-0000000005c4";
	const loc = (id: string, name: string) => `---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\nA city.\n`;
	const up = (id: string, seq: number) => ({ op: "upsert", type: "location", id, change_seq: seq, element: { id, name: "x" } });
	const r = await harnessUpload({
		notes: {
			"Location/Akragas.md": loc(CUR, "Akragas"),
			"Location/Gela.md": loc(OLD, "Gela"),
			"Location/Syracuse.md": loc(NEW, "Syracuse"),
			"Location/Kamarina.md": loc(NONE, "Kamarina"),
		},
		changes: [up(CUR, 4), up(OLD, 5), up(NONE, 6)],
		seqs: { [CUR]: 4, [OLD]: 4, [NEW]: 2 },
		stale: [OLD],
		answerSeq: (id) => (id === CUR ? 10 : id === NONE ? 11 : undefined),
	});
	assert.deepEqual(r.ifMatch, { [CUR]: 4, [OLD]: 4, [NONE]: null });
	assert.ok(r.patches[CUR] && r.patches[NONE], "the current and unguarded notes are sent");
	assert.equal(r.patches[OLD], undefined, "the stale note is not written");
	const stale = r.notices.find((n) => n.includes("changed on onlyworlds.com since"));
	assert.ok(stale && stale.includes('Location "Gela"'), JSON.stringify(r.notices));
	assert.ok(!r.notices.some((n) => /failed/.test(n)), `a 412 is no failure: ${JSON.stringify(r.notices)}`);
	assert.equal(r.seqIndex[CUR], 10);
	assert.equal(r.seqIndex[NONE], 11);
	assert.equal(r.seqIndex[OLD], 4, "the stale note keeps the number it was pulled at");
	assert.equal(NEW in r.seqIndex, false, "a created element's old number goes (/bulk answers none)");
});
