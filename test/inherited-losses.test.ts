/**
 * Losses the released plugin carried into this branch, each a vault where a
 * command lost or leaked a person's writing, run through the real command
 * over an in-memory vault:
 *   1. Update world format read an empty text property as the field's value,
 *      so a note's unsectioned body (its description) was replaced by an empty
 *      section.
 *   2. A heading that starts two sections kept only the last one's text:
 *      Update and Manage fields rebuilt the note from it, Save sent it.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __notices, __modals, type MockVault } from "./support/obsidian-mock";
import { harnessSave } from "./support/save-harness";
import { W, E } from "./support/four-notes";
import { UpdateWorldFormatCommand } from "../Commands/UpdateWorldFormatCommand";
import { ManageFieldsCommand } from "../Commands/ManageFieldsCommand";
import { PasteWorldCommand } from "../Commands/PasteWorldCommand";
import { AutoSyncEngine } from "../sync/auto-sync";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";

const A = "019e0000-0000-7000-8000-0000000000a1";

async function seedAll(vault: MockVault, notes: Record<string, string>): Promise<void> {
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **Name:** W\n");
	for (const [p, t] of Object.entries(notes)) await vault.seed(p, t);
}
function assertUnchanged(vault: MockVault, notes: Record<string, string>): void {
	for (const [p, t] of Object.entries(notes)) assert.equal(vault.contentAt(p), t, `${p} was rewritten:\n${vault.contentAt(p)}`);
}
async function update(app: App): Promise<void> {
	__notices.length = 0;
	const cmd = new UpdateWorldFormatCommand(app) as unknown as { buildPlan(w: string): Promise<unknown>; apply(p: unknown): Promise<void> };
	await cmd.apply(await cmd.buildPlan("W"));
}

// --- 1 an empty text property is no value ------------------------------------------------------

test("★ Update world format keeps a note's unsectioned body as its description when the description property is empty, blank or null", async () => {
	for (const held of ['""', '"   "', "", "null"]) {
		const { app, vault } = makeApp();
		const path = `${E}/Character/Bob.md`;
		await seedAll(vault, { [path]: `---\nname: Bob\nid: ${A}\ndescription: ${held}\n---\n\nMy only chapter.\n` });
		await update(app);
		const text = vault.contentAt(path) ?? "";
		assert.match(text, /### Description\n\nMy only chapter\.\n/, `description: ${held}\n${text}`);
		assert.doesNotMatch(text, /^description:/m, `description: ${held}\n${text}`);
	}
});

test("★ Update world format keeps a narrative's unsectioned body as its story when the story property is empty", async () => {
	const { app, vault } = makeApp();
	const path = `${E}/Narrative/Saga.md`;
	await seedAll(vault, { [path]: `---\nname: Saga\nid: ${A}\nstory: ""\n---\n\nThe only copy of my chapter.\n` });
	await update(app);
	const text = vault.contentAt(path) ?? "";
	assert.match(text, /### Story\n\nThe only copy of my chapter\.\n/, text);
});

test("Update world format still moves a text property with a value into its section, and leaves an empty one's section empty", async () => {
	const { app, vault } = makeApp();
	const path = `${E}/Character/Kai.md`;
	await seedAll(vault, { [path]: `---\nname: Kai\nid: ${A}\nphysicality: Tall.\nmentality: ""\n---\n\nA guard.\n` });
	await update(app);
	const text = vault.contentAt(path) ?? "";
	assert.match(text, /### Description\n\nA guard\.\n/, text);
	assert.match(text, /### Physicality\n\nTall\.\n/, text);
	assert.match(text, /### Mentality\n\n\n### /, text);
	assert.doesNotMatch(text, /^mentality:/m, text);
});

// --- 2 a heading that starts two sections ------------------------------------------------------

const TWICE = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nMy only chapter.\n\n### Description\n\nA new summary.\n`;
const LOOKS_TWICE = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n\n### Looks\n\nMy only portrait.\n\n### looks\n\nTall.\n`;
const twiceNamed = (notices: string[], heading: string, verb: string) =>
	notices.some((n) => n.startsWith(`Bob ${verb}`) && n.includes(`"${heading}"`) && /there twice/.test(n) && /Keep one, then try again/.test(n));

test("★ Update world format leaves a note with a heading there twice byte for byte, and names the heading", async () => {
	for (const [body, heading] of [[TWICE, "Description"], [LOOKS_TWICE, "Looks"]] as const) {
		const { app, vault } = makeApp();
		const notes = { [`${E}/Character/Bob.md`]: body };
		await seedAll(vault, notes);
		await update(app);
		assertUnchanged(vault, notes);
		assert.ok(twiceNamed(__notices, heading, "not updated"), __notices.join(" | "));
	}
});

test("★ Save sends nothing from a note with a field's heading there twice, by hand or by auto-sync, and says it once a session by auto-sync", async () => {
	for (const body of [TWICE, LOOKS_TWICE]) {
		const server = { [A]: { name: "Bob", description: "Server text." } };
		const heading = body === TWICE ? "Description" : "Looks";
		const byHand = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server, manual: true });
		assert.deepEqual(byHand.calls, [], `${heading}: ` + byHand.calls.join(" | "));
		assert.ok(twiceNamed(byHand.notices, heading, "not saved"), byHand.notices.join(" | "));
		assert.equal(byHand.vault.contentAt(`${E}/Character/Bob.md`), body);
		const auto = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server, manual: false });
		assert.deepEqual(auto.calls, [], auto.calls.join(" | "));
		assert.equal(auto.result.ok, false);
		const again = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server, manual: false });
		assert.deepEqual(again.calls, []);
		assert.deepEqual(again.notices, [], "auto-sync said it again: " + again.notices.join(" | "));
	}
});

test("Save still sends a note whose repeated heading is prose it folds into the description: both sections travel", async () => {
	const body = `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nA guard.\n\n### The war, part one\n\nFirst.\n\n### The war, part one\n\nSecond.\n`;
	const saved = await harnessSave({ notes: { "Character/Bob.md": body }, save: "Character/Bob.md", server: { [A]: { name: "Bob", description: "Old." } }, manual: true });
	assert.deepEqual(saved.calls, [`get character ${A}`, `update character ${A}`], saved.calls.join(" | ") + " :: " + saved.notices.join(" | "));
	const sent = String(saved.sent[0]?.description);
	assert.ok(sent.includes("First.") && sent.includes("Second."), sent);
});

test("★ Manage fields leaves a note with a heading there twice, from the command and from a dialog opened before", async () => {
	for (const [body, heading] of [[TWICE, "Description"], [LOOKS_TWICE, "Looks"]] as const) {
		const { app, vault } = makeApp();
		const path = `${E}/Character/Bob.md`;
		await seedAll(vault, { [path]: body });
		const file = app.vault.getAbstractFileByPath(path) as TFile;
		(app as unknown as { workspace: { getActiveFile(): TFile } }).workspace.getActiveFile = () => file;
		__notices.length = 0;
		__modals.length = 0;
		await new ManageFieldsCommand(app).execute();
		assert.equal(__modals.length, 0, "the dialog opened");
		assert.ok(twiceNamed(__notices, heading, "not changed"), __notices.join(" | "));
		__notices.length = 0;
		const cmd = new ManageFieldsCommand(app) as unknown as { applySelection(f: TFile, c: string, s: Set<string>, ch: unknown[]): Promise<void> };
		await cmd.applySelection(file, "character", new Set(["description", "physicality"]), []);
		assert.equal(vault.contentAt(path), body);
		assert.ok(twiceNamed(__notices, heading, "not changed"), __notices.join(" | "));
	}
});

// --- 3 Save reads a note's identity from the bytes it sends ----------------------------------------

const B = "019e0000-0000-7000-8000-0000000000b2";

/** A save with the metadata cache answering `entry` for every note whose path ends in `end`. */
async function saveWithCache(end: string, entry: unknown, o: Parameters<typeof harnessSave>[0]) {
	const proto = (await import("./support/obsidian-mock")).MockMetadataCache.prototype as unknown as { getFileCache(f: { path: string }): unknown };
	const orig = proto.getFileCache;
	proto.getFileCache = function (this: unknown, f: { path: string }) {
		return f.path.endsWith(end) ? entry : orig.call(this, f);
	};
	try {
		return await harnessSave(o);
	} finally {
		proto.getFileCache = orig;
	}
}
const STALE_BOB = { frontmatter: { id: A, name: "Bob" } };

test("★ Save sends nothing from a note whose front matter was just removed, though the cache still holds its id, by hand or by auto-sync", async () => {
	const mine = "My private rewrite, no longer an element.\n";
	const server = { [A]: { name: "Bob", description: "Bob's chapter." } };
	for (const manual of [true, false]) {
		const r = await saveWithCache("Character/Bob.md", STALE_BOB, { notes: { "Character/Bob.md": mine }, save: "Character/Bob.md", server, manual });
		assert.deepEqual(r.calls, [], `manual ${manual}: ` + r.calls.join(" | ") + " :: " + JSON.stringify(r.sent));
		assert.equal(r.vault.contentAt(`${E}/Character/Bob.md`), mine);
	}
});

test("★ Save sends nothing from a note outside the type folders whose id was taken out, though the cache still says it is an element", async () => {
	const diary = `---\nid: false\n---\n\n### Description\n\nA new private chapter.\n`;
	const r = await saveWithCache("Drafts/Diary.md", { frontmatter: { id: A, name: "Diary", type: "character" } }, {
		notes: { "~/Drafts/Diary.md": diary },
		save: "~/Drafts/Diary.md",
		server: { [A]: { name: "Diary", description: "Old." } },
		manual: false,
	});
	assert.deepEqual(r.calls, [], r.calls.join(" | ") + " :: " + JSON.stringify(r.sent));
});

test("★ Save sends a note under the id and name its bytes hold, not the cache's", async () => {
	const bobby = `---\nname: Bobby\nid: ${B}\n---\n\n### Description\n\nBobby's chapter.\n`;
	const r = await saveWithCache("Character/Bob.md", STALE_BOB, {
		notes: { "Character/Bob.md": bobby },
		save: "Character/Bob.md",
		server: { [A]: { name: "Bob", description: "Bob's chapter." }, [B]: { name: "Bob", description: "Old." } },
		manual: true,
	});
	assert.deepEqual(r.calls, [`get character ${B}`, `update character ${B}`], r.calls.join(" | ") + " :: " + r.notices.join(" | "));
	assert.equal(r.sent[0]?.name, "Bobby", JSON.stringify(r.sent));
});

test("★ Save refuses a note whose bytes hold a hidden or last-known id, whatever id the cache holds", async () => {
	const held = `---\nname: Bob\nid: ${B}\n---\n\n### Description\n\nA new chapter.\n`;
	const server = { [A]: { name: "Bob", description: "Bob's chapter." }, [B]: { name: "Bob", description: "Old." } };
	const hidden = await saveWithCache("Character/Bob.md", STALE_BOB, { notes: { "Character/Bob.md": held }, save: "Character/Bob.md", server, hidden: [B], manual: true });
	assert.deepEqual(hidden.calls, [], "hidden: " + hidden.calls.join(" | "));
	assert.ok(hidden.notices.some((n) => /Hidden by the world's owner/.test(n)), hidden.notices.join(" | "));
	const last = await saveWithCache("Character/Bob.md", STALE_BOB, { notes: { "Character/Bob.md": held }, save: "Character/Bob.md", server, lastKnown: [B], manual: true });
	assert.deepEqual(last.calls, [], "last known: " + last.calls.join(" | "));
	assert.ok(last.notices.some((n) => /Known of now/.test(n)), last.notices.join(" | "));
});

// --- 4 Paste world's writes are the plugin's own -----------------------------------------------------

test("★ Paste world marks each element note it writes as its own: auto-sync schedules no save of pasted content", async () => {
	const { app, vault } = makeApp();
	await seedAll(vault, { [`${E}/Character/Bob.md`]: `---\nname: Bob\nid: ${A}\n---\n\n### Description\n\nOld text.\n` });
	// The real auto-sync engine, its modify listener fed by the vault's writes.
	const listeners: ((f: unknown) => void)[] = [];
	const v = app.vault as unknown as { on(name: string, cb: (f: unknown) => void): unknown; modify(f: TFile, c: string): Promise<void> };
	v.on = (name, cb) => {
		if (name === "modify") listeners.push(cb);
		return {};
	};
	const modify = v.modify.bind(app.vault);
	v.modify = async (f, c) => {
		await modify(f, c);
		for (const cb of listeners) cb(f);
	};
	const statuses: string[] = [];
	const plugin = { settings: { apiKey: "", debounceMs: 5, autoSync: true }, setSyncStatus: (s: string) => statuses.push(s), registerEvent: () => {} };
	const engine = new AutoSyncEngine(app, plugin as never);
	engine.registerListeners();
	const cmd = new PasteWorldCommand(app, {} as never, undefined, (p: string) => engine.markSelfWrite(p));
	await cmd.generateElementNotes(`${E}`, {
		Character: [
			{ id: A, name: "Bob", description: "Pasted over." },
			{ id: B, name: "Kai", description: "Pasted new." },
		],
	}, false);
	await new Promise((r) => setTimeout(r, 30));
	assert.match(vault.contentAt(`${E}/Character/Bob.md`) ?? "", /Pasted over\./);
	assert.match(vault.contentAt(`${E}/Character/Kai.md`) ?? "", /Pasted new\./);
	assert.deepEqual(statuses, [], "auto-sync took a pasted note for an edit: " + statuses.join(" | "));
	// The marks are one-shot: the person's next edit of a pasted note is saved.
	await app.vault.modify(app.vault.getAbstractFileByPath(`${E}/Character/Kai.md`) as TFile, "---\nname: Kai\nid: " + B + "\n---\n\n### Description\n\nMy edit.\n");
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(statuses[0], "dirty", statuses.join(" | "));
	const timers = (engine as unknown as { timers: Map<string, ReturnType<typeof setTimeout>> }).timers;
	for (const t of timers.values()) clearTimeout(t);
});

// --- 5 a bold ID line in a person's note is no element's id ---------------------------------------
// No version of the plugin, and no upstream template it fetched, wrote a `- **ID:**` line into an
// element note (World.md's `- **Id:**` line is the world's): such a line is the person's writing.

const BOLD = `My notes on Bob, the only copy.\n\n- **ID:** ${A}\n\nMore of my writing.\n`;
const LOOSE = `My notes on Bob, the only copy.\n\n- Bob's Id: ${A}\n`;

test("★ Download leaves a note of the person's own with a bold ID line, or a line naming an Id, unwritten and unrenamed, and gives the element a fresh note", async () => {
	for (const [mine, name] of [[BOLD, "Bob"], [BOLD, "Robert"], [LOOSE, "Robert"]] as const) {
		const { app, vault } = makeApp();
		const path = `${E}/Character/Bob.md`;
		await seedAll(vault, { [path]: mine });
		(app as unknown as { realRenames: boolean }).realRenames = true;
		const dl = new DownloadWorldCommand(app, {});
		await dl.generateElementNotes(E, { Character: [{ id: A, name, description: "The server's text." }] }, false);
		const label = `${name} over ${mine === BOLD ? "a bold ID line" : "an Id line"}`;
		assert.equal(vault.contentAt(path), mine, `${label}: the person's note was written or renamed`);
		const fresh = name === "Bob" ? `${E}/Character/Bob (1).md` : `${E}/Character/Robert.md`;
		assert.match(vault.contentAt(fresh) ?? "", new RegExp(`id: ${A}[\\s\\S]*The server's text\\.`), `${label}: ` + JSON.stringify([...vault.files.keys()]));
	}
});

test("★ Paste world leaves a note of the person's own with a bold ID line unwritten, and gives the element a fresh note", async () => {
	const { app, vault } = makeApp();
	const path = `${E}/Character/Bob.md`;
	await seedAll(vault, { [path]: BOLD });
	await new PasteWorldCommand(app, {} as never).generateElementNotes(E, { Character: [{ id: A, name: "Bob", description: "Pasted." }] }, false);
	assert.equal(vault.contentAt(path), BOLD, "the person's note was written over");
	assert.match(vault.contentAt(`${E}/Character/Bob (1).md`) ?? "", /Pasted\./, JSON.stringify([...vault.files.keys()]));
});
