/**
 * The two windows of a pull's copy before replace, both milliseconds wide. (1) The note's mark is the hash of the bytes the
 * write put there, never a read after it: text typed just after the write is the person's, and the next pull copies it.
 * (2) Text typed after the pull read the note (while its copy is written, or just before the write) is in a copy or stays in
 * the note, never in neither: the write replaces exactly the bytes last handed to the copy, through `vault.process`, and a
 * note found changed is copied again and tried again, three times, then left as the person has it.
 *
 * The typing is injected at the moment itself: inside the copy's create, and just before the write (the mock's
 * `beforeProcess`, or a direct `vault.modify` when the write does not go through `process`).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, __notices } from "./support/obsidian-mock";
import type { MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { markKey, noteMark } from "../vault/note-mark-core";

const W = "OnlyWorlds/Worlds/W";
const ELEMENTS = `${W}/Elements`;
const NOTE = `${ELEMENTS}/Character/Ireena.md`;
const SEQ = `${W}/.ow-seq.json`;
const KEPT = `${W}/Kept edits/`;
const ID = "019a0000-0000-7000-8000-0000000000f1";

type App = ReturnType<typeof makeApp>["app"];
type Vaultish = { process(f: unknown, fn: (d: string) => string): Promise<string>; modify(f: unknown, c: string): Promise<void>; create(p: string, c: string): Promise<unknown> };

async function world(marks: string[] = []) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	const plugin = { autoSync: { markSelfWrite: (p: string) => marks.push(`mark ${p}`) } };
	return { app, vault, dl: new DownloadWorldCommand(app, {}, plugin as never) };
}
const el = (description: string) => ({ Character: [{ id: ID, name: "Ireena", description }] });
const index = (vault: MockVault): Record<string, number> => JSON.parse(vault.dotfiles.get(SEQ) ?? "{}");
const copies = (vault: MockVault) => [...vault.files.keys()].filter((p) => p.startsWith(KEPT));
/** A person's typing into the note's description, straight into its bytes (no write of the plugin's). */
function typeInto(vault: MockVault, text: string): void {
	const e = vault.files.get(NOTE);
	if (!e) throw new Error("no note to type into");
	e.content = e.content.replace("### Description\n\n", `### Description\n\n${text} `);
}
/** Where each typed text ended: in the note, in a copy, or nowhere. */
function whereIs(vault: MockVault, text: string): string[] {
	const out: string[] = [];
	if ((vault.contentAt(NOTE) ?? "").includes(text)) out.push("note");
	for (const p of copies(vault)) if ((vault.contentAt(p) ?? "").includes(text)) out.push(p);
	return out;
}

/**
 * Type into the note at the moment just before its write lands, `times` times (one new text each): inside `vault.process`'s
 * own moment before its read (the mock's beforeProcess), or before a `vault.modify` of the note made outside `process`. Returns
 * the texts typed so far.
 */
function typeAtTheWrite(app: App, vault: MockVault, times: number): string[] {
	const typed: string[] = [];
	const v = app.vault as unknown as Vaultish;
	let inside = false;
	const type = () => {
		if (typed.length >= times) return;
		const text = `Typed at the write ${typed.length + 1}.`;
		typeInto(vault, text);
		typed.push(text);
	};
	vault.beforeProcess = (f) => { if (f.path === NOTE) type(); };
	const process = v.process.bind(v);
	v.process = async (f, fn) => {
		inside = true;
		try { return await process(f, fn); } finally { inside = false; }
	};
	const modify = v.modify.bind(v);
	v.modify = async (f, c) => {
		if (!inside && (f as { path: string }).path === NOTE) type();
		return modify(f, c);
	};
	return typed;
}

test("★ the mark is the hash of the bytes the pull wrote, not a read after it: text typed just after the write is copied by the next pull", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	const v = app.vault as unknown as Vaultish;
	const modify = v.modify.bind(v);
	let wrote: string | null = null;
	v.modify = async (f, c) => {
		await modify(f, c);
		if ((f as { path: string }).path === NOTE && wrote === null) {
			wrote = c;
			typeInto(vault, "Typed just after the write.");
		}
	};
	await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.ok(wrote, "the pull did not write the note");
	assert.equal(index(vault)[markKey(ID)], noteMark(wrote ?? ""), "the mark is not the hash of the bytes the pull wrote");
	v.modify = modify;
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed once more."), false);
	assert.deepEqual(r.copied, ['Character "Ireena"'], "the next pull took the typed text for the world's bytes");
	assert.ok(whereIs(vault, "Typed just after the write.").some((p) => p.startsWith(KEPT)), "the typed text is in no copy");
});

test("★ text typed while the copy is being written is in a copy or in the note, never in neither", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	typeInto(vault, "Typed before the pull.");
	const v = app.vault as unknown as Vaultish;
	const create = v.create.bind(v);
	let once = false;
	v.create = async (p, c) => {
		if (p.startsWith(KEPT) && !once) {
			once = true;
			typeInto(vault, "Typed during the copy.");
		}
		return create(p, c);
	};
	await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.ok(once, "no copy was written");
	assert.notDeepEqual(whereIs(vault, "Typed before the pull."), [], "the first typing is in neither");
	assert.notDeepEqual(whereIs(vault, "Typed during the copy."), [], "text typed during the copy is in neither the copy nor the note");
});

test("★ text typed between the pull's read and its write is in a copy or in the note, and the world's copy is written", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	const typed = typeAtTheWrite(app, vault, 1);
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.deepEqual(typed, ["Typed at the write 1."]);
	assert.notDeepEqual(whereIs(vault, typed[0]), [], "text typed just before the write is in neither the copy nor the note");
	assert.match(vault.contentAt(NOTE) ?? "", /Changed on the server\./, "the world's copy was not written after the copy");
	assert.deepEqual(r.copied, ['Character "Ireena"']);
	assert.equal(index(vault)[markKey(ID)], noteMark(vault.contentAt(NOTE) ?? ""));
});

test("★ a note that changes each time the write comes to it is left as the person has it after three tries, and the pull says so", async () => {
	const { app, vault, dl } = await world();
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	const before = index(vault)[markKey(ID)];
	const typed = typeAtTheWrite(app, vault, 100);
	__notices.length = 0;
	const r = await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	assert.equal(typed.length, 3, `the write tried ${typed.length} times, not three`);
	for (const t of typed) assert.notDeepEqual(whereIs(vault, t), [], `${t} is in neither`);
	assert.doesNotMatch(vault.contentAt(NOTE) ?? "", /Changed on the server\./, "the note was written over after all");
	assert.ok(typed.every((t) => (vault.contentAt(NOTE) ?? "").includes(t)), "the note is not as the person has it");
	assert.deepEqual(r.landed, [], "a note left as the person has it counts as landed: its number would move");
	assert.equal(index(vault)[markKey(ID)], before, "the mark moved for a note that was not written");
	const said = __notices.find((n) => /did not write/.test(n)) ?? "";
	assert.match(said, /Character "Ireena"/, __notices.join(" | "));
	assert.match(said, /left as you have it/, said);
});

test("the self-write mark is taken before each real write of the note and for no try that did not write", async () => {
	const marks: string[] = [];
	const { app, vault, dl } = await world(marks);
	await dl.generateElementNotes(ELEMENTS, el("A noble."), false);
	typeAtTheWrite(app, vault, 1);
	const v = app.vault as unknown as Vaultish;
	const modify = v.modify.bind(v);
	v.modify = async (f, c) => {
		marks.push(`write ${(f as { path: string }).path}`);
		return modify(f, c);
	};
	marks.length = 0;
	await dl.generateElementNotes(ELEMENTS, el("Changed on the server."), false);
	const ofNote = marks.filter((m) => m.endsWith(NOTE));
	assert.deepEqual(ofNote, [`mark ${NOTE}`, `write ${NOTE}`], ofNote.join(" | "));
});
