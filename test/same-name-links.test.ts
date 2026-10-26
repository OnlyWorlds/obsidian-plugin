/**
 * A link to one of two same-name notes names THAT note — run against the REAL
 * DownloadWorldCommand note writer and the real upload collector through an
 * in-memory vault (test/support/obsidian-mock.ts; its link resolver is a
 * basename emulation of Obsidian's).
 *
 * ★ Row 2 of the data-paths ranking: download wrote
 * `[[Twin]]` for both twins although the second one's note is `Twin (1).md`,
 * so on upload the second twin's link became the first twin's id.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, __notices } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { readElement } from "../vault/element-file";
import { V2Client } from "../client-v2";

const ELEMENTS = "OnlyWorlds/Worlds/W/Elements";
const T1 = "019a0000-0000-7000-8000-0000000000e1";
const T2 = "019a0000-0000-7000-8000-0000000000e2";
const H = "019a0000-0000-7000-8000-0000000000e3";

async function downloadThenCollect(data: Record<string, unknown[]>) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	await new DownloadWorldCommand(app, {}).generateElementNotes(ELEMENTS, data, false);
	const collected = (await new ExportWorldCommand(app, {} as never, new WorldService(app)).collectWorldData("W")) as Record<
		string,
		Record<string, unknown>[]
	>;
	const byId = new Map<string, Record<string, unknown>>();
	for (const [k, list] of Object.entries(collected)) {
		if (k === "World" || !Array.isArray(list)) continue;
		for (const el of list) byId.set(String(el.id), el);
	}
	return { app, vault, byId };
}

test("★ two same-name twins download and re-upload with every link id unchanged (row 2)", async () => {
	const { vault, byId } = await downloadThenCollect({
		Character: [
			{ id: T1, name: "Twin", description: "The elder." },
			{ id: T2, name: "Twin", description: "The younger." },
			{ id: H, name: "Holder", friends: [T1, T2], rivals: [T2] },
		],
	});
	// The second twin lives at `Twin (1).md`; its link must say so.
	const holder = vault.contentAt(`${ELEMENTS}/Character/Holder.md`) ?? "";
	assert.match(holder, /\[\[Twin \(1\)\]\]/, holder);
	assert.deepEqual(byId.get(H)?.friends, [T1, T2]);
	assert.deepEqual(byId.get(H)?.rivals, [T2]);
});

test("a twin downloaded later links to the twin note already in the vault", async () => {
	// First pull: only the elder twin exists. Second pull: the younger arrives
	// with a holder that links to both.
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "# World Overview: W\n\n- **API Key:** ow_k_test\n");
	await vault.createFolder(ELEMENTS);
	const dl = new DownloadWorldCommand(app, {});
	await dl.generateElementNotes(ELEMENTS, { Character: [{ id: T1, name: "Twin" }] }, false);
	await dl.generateElementNotes(
		ELEMENTS,
		{ Character: [{ id: T2, name: "Twin" }, { id: H, name: "Holder", friends: [T2, T1] }] },
		false
	);
	const holder = vault.contentAt(`${ELEMENTS}/Character/Holder.md`) ?? "";
	assert.match(holder, /- "\[\[Twin \(1\)\]\]"\n\s+- "\[\[Twin\]\]"/, holder);
});

// ★ Cross-type (ruling: option 2). A Location and a Collective both named
// Syracuse are both `Syracuse.md`, in different folders; download writes plain
// [[Syracuse]]. Upload resolves a link FIELD against notes of the field's
// target type only, so the name cannot land on the other type's note.
const LOC = "019a0000-0000-7000-8000-0000000000f1";
const COL = "019a0000-0000-7000-8000-0000000000f2";
const GELON = "019a0000-0000-7000-8000-0000000000f3";
const AKRAI = "019a0000-0000-7000-8000-0000000000f4";
const PIN = "019a0000-0000-7000-8000-0000000000f5";
const SYRACUSE = {
	Location: [
		{ id: LOC, name: "Syracuse" },
		{ id: AKRAI, name: "Akrai", populations: [COL], partner: LOC },
	],
	Collective: [{ id: COL, name: "Syracuse" }],
	Character: [{ id: GELON, name: "Gelon", location: LOC }],
	// No element_type: the generic rule applies (ambiguous -> omit and name).
	Pin: [{ id: PIN, name: "Syracuse pin", element_type: "", element_id: LOC }],
};

test("★ a Location and a Collective both named Syracuse download and re-upload with every link id unchanged (row 2)", async () => {
	const { byId } = await downloadThenCollect(SYRACUSE);
	assert.equal(byId.get(GELON)?.location, LOC, "Gelon's location");
	assert.deepEqual(byId.get(AKRAI)?.populations, [COL], "Akrai's populations (a Collective field)");
	assert.equal(byId.get(AKRAI)?.partner, LOC, "Akrai's partner (a Location field, same folder as both)");
});

test("★ a Pin element_id with no element_type naming two types is left out and named, never guessed (row 2)", async () => {
	const { byId, vault, app } = await downloadThenCollect(SYRACUSE);
	const pin = byId.get(PIN);
	assert.ok(pin, "the pin was collected");
	assert.ok(!("element_id" in pin), `element_id must be omitted, got ${JSON.stringify(pin.element_id)}`);
	const file = app.vault.getAbstractFileByPath(`${ELEMENTS}/Pin/Syracuse pin.md`);
	const parsed = await readElement(app, file as never);
	assert.deepEqual(parsed?.ambiguousLinks, ["Syracuse"]);
	assert.ok(vault.contentAt(`${ELEMENTS}/Pin/Syracuse pin.md`)?.includes('element_id: "[[Syracuse]]"'));

	// The Save command names it in a Notice.
	__notices.length = 0;
	const client = {
		get: async () => ({ id: PIN, name: "Syracuse pin" }),
		update: async () => ({}),
		create: async () => ({}),
	};
	const plugin = { settings: { apiKey: "" }, buildV2Client: async () => client };
	await new SaveElementCommand(app, plugin as never).execute(file as never);
	assert.ok(
		__notices.some((n) => /Syracuse/.test(n) && /more than one type/.test(n)),
		JSON.stringify(__notices)
	);
});

test("the upload sweep names the ambiguous generic link too", async () => {
	const { app } = await downloadThenCollect(SYRACUSE);
	const proto = V2Client.prototype as unknown as Record<string, unknown>;
	const saved = { changesWalk: proto.changesWalk, bulkCreate: proto.bulkCreate };
	proto.changesWalk = async () => ({ changes: [], cursor: null, head: 0 });
	proto.bulkCreate = async (items: { element: { id: string } }[]) => ({
		errors: false,
		items: items.map((it) => ({ status: 201, id: it.element.id })),
	});
	try {
		const cmd = new ExportWorldCommand(app, {} as never, new WorldService(app));
		const data = await cmd.collectWorldData("W");
		__notices.length = 0;
		await (cmd as unknown as { uploadViaV2(p: number, w: string, d: unknown): Promise<void> }).uploadViaV2(1234, "W", data);
	} finally {
		Object.assign(proto, saved);
	}
	assert.ok(__notices.some((n) => /Syracuse/.test(n) && /more than one type/.test(n)), JSON.stringify(__notices));
});

test("a generic-target field naming ONE note resolves to it", async () => {
	const { byId } = await downloadThenCollect({
		Location: [{ id: LOC, name: "Syracuse" }],
		Pin: [{ id: PIN, name: "Syracuse pin", element_id: LOC }],
	});
	assert.equal(byId.get(PIN)?.element_id, LOC);
});

test("★ a Pin carrying element_type resolves element_id against that type only (row 2)", async () => {
	const PIN_L = "019a0000-0000-7000-8000-0000000000f6";
	const PIN_C = "019a0000-0000-7000-8000-0000000000f7";
	const { byId } = await downloadThenCollect({
		...SYRACUSE,
		Pin: [
			{ id: PIN_L, name: "Located pin", element_type: "Location", element_id: LOC },
			{ id: PIN_C, name: "People pin", element_type: "collective", element_id: COL },
		],
	});
	assert.equal(byId.get(PIN_L)?.element_id, LOC, "element_type Location");
	assert.equal(byId.get(PIN_C)?.element_id, COL, "element_type collective");
});
