/**
 * 3.10 (OW Obsidian #564): the SDK at 4.x and the server's seven keys.
 *
 * - FIELD_SCHEMA is @onlyworlds/sdk 4.x's (standard 00.33.00): no `number`
 *   type anywhere (it is `integer`), and Zone has `shape`, a text field, so a
 *   body section like every other text field.
 * - Download writes the server's seven keys (`created_at`, `updated_at`,
 *   `change_seq`, `created_by`, `changed_by`, `changed_via`, `changed_client`)
 *   into every note under their wire names, a null one left out (R3).
 * - A save never sends one of them; the edit still goes.
 * - The folder export writes them back, a null one as null.
 * Boss's D5 compare of 3.8.1 (`Orrery/obsidian/deep/D5-plugin-3.8.1-rerun.md`)
 * found them on 0 of 310 notes and `shape` on 0 of 10 Zones.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import "./support/bare-paths";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { FIELD_SCHEMA, ONLYWORLDS_VERSION } from "@onlyworlds/sdk";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { readElement } from "../vault/element-file";
import { SERVER_FIELDS, apiDataToFrontmatter, frontmatterToPayloadFields, getCategorySchema, bodyTextFields } from "../vault/element-transform";
import { folderServerFields } from "../vault/folder-format";
import { harnessSave } from "./support/save-harness";

const WID = "019e0000-0000-7000-8000-0000000006ee";
const IRE = "019e0000-0000-7000-8000-0000000006c1";
const STRAHD = "019e0000-0000-7000-8000-0000000006c2";
const BORDER = "019e0000-0000-7000-8000-0000000006d1";
const MEMBER = "019e0000-0000-7000-8000-0000000006a1";
const OTHER = "019e0000-0000-7000-8000-0000000006a2";

/** The server's seven as keel serves them on a member's element. */
const SERVED = {
	created_at: "2026-10-20T10:00:00.123456Z",
	updated_at: "2026-10-22T18:30:00Z",
	change_seq: 41,
	created_by: MEMBER,
	changed_by: OTHER,
	changed_via: "seat",
	changed_client: "atlas",
};
/** The owner's element: created_by, changed_by and changed_client null. */
const SERVED_OWNER = {
	created_at: "2026-10-20T10:00:00Z",
	updated_at: "2026-10-20T10:00:00Z",
	change_seq: 7,
	created_by: null,
	changed_by: null,
	changed_via: "key",
	changed_client: null,
};

const upsert = (type: string, element: Record<string, unknown>) => ({
	op: "upsert", type, id: element.id, change_seq: element.change_seq, updated_at: element.updated_at, element,
});

async function download(app: App, changes: unknown[], head: number): Promise<void> {
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WID, name: "Barovia", description: "" } };
		if (path === "/changes") return { status: 200, json: { cursor: `c${head}`, has_more: false, head, changes } };
		return { status: 404, json: {} };
	});
	__notices.length = 0;
	const plugin = { settings: { syncCursors: {} }, saveSettings: async () => {} };
	await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_k_test", "1234");
}

function noteOf(app: App, id: string): { file: TFile; content: string } {
	const vault = app.vault as unknown as { getMarkdownFiles(): TFile[]; files: Map<string, { content: string }> };
	for (const f of vault.getMarkdownFiles()) {
		const content = vault.files.get(f.path)?.content ?? "";
		if (content.includes(`id: ${id}`)) return { file: f, content };
	}
	throw new Error(`no note for ${id}`);
}

/** The frontmatter block of a note, without its fences. */
function fmOf(content: string): string {
	return content.split("\n---\n")[0].replace(/^---\n/, "");
}

// --- the schema ------------------------------------------------------------------

test("★ FIELD_SCHEMA is the SDK 4.x table at 00.33.00: no `number` type the plugin reads, whole numbers are `integer`", () => {
	assert.equal(ONLYWORLDS_VERSION, "00.33.00");
	const types = new Set<string>();
	for (const [cat, fields] of Object.entries(FIELD_SCHEMA as Record<string, Record<string, { type: string }>>)) {
		for (const f of Object.values(fields)) types.add(f.type);
		for (const f of Object.values(getCategorySchema(cat) ?? {})) types.add(f.type);
	}
	assert.deepEqual([...types].sort(), ["integer", "multi_link", "single_link", "text"]);
	assert.equal(getCategorySchema("character")?.height.type, "integer");
	// 4.0.1's fix, now the plugin's: a Collective's equipment links Objects.
	assert.equal(getCategorySchema("collective")?.equipment.target, "object");
});

test("★ Zone `shape` is a schema text field: a body section, after the description, never a frontmatter key", () => {
	assert.deepEqual(getCategorySchema("zone")?.shape, { type: "text" });
	assert.ok(bodyTextFields("zone").includes("shape"), bodyTextFields("zone").join(","));
	const fm = apiDataToFrontmatter({ id: BORDER, name: "Border", shape: "line" }, "zone", BORDER);
	assert.ok(!("shape" in fm), "shape went to the frontmatter");
});

// --- Download ----------------------------------------------------------------------

test("★ Download: a Character note carries the server's seven keys with the server's values, last, under their wire names", async () => {
	const { app } = makeApp();
	await download(app, [upsert("character", { type: "character", id: IRE, name: "Ireena", description: "A noble.", height: 170, ...SERVED })], 41);
	const fm = fmOf(noteOf(app, IRE).content);
	assert.ok(
		fm.endsWith(
			'created_at: "2026-10-20T10:00:00.123456Z"\nupdated_at: "2026-10-22T18:30:00Z"\nchange_seq: 41\n' +
				`created_by: ${MEMBER}\nchanged_by: ${OTHER}\nchanged_via: seat\nchanged_client: atlas`
		),
		fm
	);
	assert.ok(fm.startsWith(`name: Ireena\nid: ${IRE}\n`) && fm.includes("\nheight: 170\n"), fm);
	const parsed = await readElement(app, noteOf(app, IRE).file);
	assert.ok(parsed);
	assert.deepEqual(parsed.serverFields, SERVED, "the reader did not read the seven back as written");
	for (const k of SERVER_FIELDS) {
		assert.ok(!(k in parsed.fields) && !(`x_${k}` in parsed.fields), `${k} would be sent`);
	}
});

test("★ Download: a null server key is left out of the note, as every empty field is (R3); a later pull replaces the seven", async () => {
	const { app } = makeApp();
	await download(app, [upsert("character", { type: "character", id: STRAHD, name: "Strahd", ...SERVED })], 41);
	assert.match(noteOf(app, STRAHD).content, /\nchanged_by: /);
	// The owner edits it: keel now serves changed_by and changed_client null.
	await download(app, [upsert("character", { type: "character", id: STRAHD, name: "Strahd", ...SERVED, change_seq: 42, changed_by: null, changed_client: null, changed_via: "key" })], 42);
	const fm = fmOf(noteOf(app, STRAHD).content);
	assert.ok(fm.includes(`created_by: ${MEMBER}\nchanged_via: key`), fm);
	assert.ok(!/changed_by|changed_client/.test(fm), `a null key stayed from the last pull:\n${fm}`);
	assert.match(fm, /\nchange_seq: 42\n/);
});

test("★ Download: a Zone note carries `shape` as its `### Shape` section, and the reader reads it back", async () => {
	const { app } = makeApp();
	await download(app, [upsert("zone", { type: "zone", id: BORDER, name: "The Border", description: "", shape: "line", role: "", ...SERVED_OWNER })], 7);
	const { file, content } = noteOf(app, BORDER);
	assert.ok(content.includes("### Shape\n\nline\n"), content);
	const parsed = await readElement(app, file);
	assert.equal(parsed?.fields.shape, "line");
});

// --- Save ----------------------------------------------------------------------------

const NOTE_WITH_SEVEN = (desc: string) =>
	`---\nname: Ireena\nid: ${IRE}\nheight: 170\ncreated_at: "2026-10-20T10:00:00Z"\nupdated_at: "2026-10-20T10:00:00Z"\nchange_seq: 7\n` +
	`created_by: ${MEMBER}\nchanged_by: ${OTHER}\nchanged_via: seat\nchanged_client: atlas\n---\n\n### Description\n\n${desc}\n`;

test("★ Save: a note edited with the seven present PATCHes none of them, and still sends the edit", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": NOTE_WITH_SEVEN("A noble, edited.") },
		save: "Character/Ireena.md",
		server: { [IRE]: { name: "Ireena", description: "A noble.", height: 170, ...SERVED } },
	});
	assert.equal(r.result.ok, true, JSON.stringify(r.result));
	assert.deepEqual(r.calls.filter((c) => c.startsWith("update")), [`update character ${IRE}`]);
	assert.deepEqual(r.sent, [{ description: "A noble, edited." }]);
});

test("★ Save: the seven differing from the server's (a note pulled before) are still not sent; the server's keys stay the server's", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": NOTE_WITH_SEVEN("A noble.").replace("height: 170", "height: 171") },
		save: "Character/Ireena.md",
		server: { [IRE]: { name: "Ireena", description: "A noble.", height: 170, ...SERVED } },
	});
	assert.equal(r.result.ok, true, JSON.stringify(r.result));
	assert.deepEqual(r.sent, [{ height: 171 }]);
});

test("★ Save: a create (never uploaded) sends none of the seven either", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": NOTE_WITH_SEVEN("A noble.") },
		save: "Character/Ireena.md",
		feed: [],
		cursor: { cursor: "c1", head: 1 },
	});
	assert.equal(r.result.ok, true, JSON.stringify(r.result));
	assert.equal(r.sent.length, 1);
	for (const k of SERVER_FIELDS) assert.ok(!(k in r.sent[0]) && !(`x_${k}` in r.sent[0]), `${k} sent on create`);
});

test("★ Save: a Zone's edited `### Shape` is sent; a Zone note with no Shape section sends no shape", async () => {
	const zone = (shape: string | null) =>
		`---\nname: The Border\nid: ${BORDER}\n---\n\n### Description\n\n\n### Role\n\n${shape === null ? "" : `\n### Shape\n\n${shape}\n`}`;
	const server = { [BORDER]: { name: "The Border", description: "", role: "", shape: "line" } };
	const edited = await harnessSave({ notes: { "Zone/The Border.md": zone("polygon") }, save: "Zone/The Border.md", server });
	assert.equal(edited.result.ok, true, JSON.stringify(edited.result));
	assert.deepEqual(edited.sent, [{ shape: "polygon" }]);
	const older = await harnessSave({ notes: { "Zone/The Border.md": zone(null) }, save: "Zone/The Border.md", server });
	assert.equal(older.result.ok, true, JSON.stringify(older.result));
	assert.deepEqual(older.sent, [], "a note from before 3.10 cleared the server's shape");
});

test("the payload reader never adopts a server key as `x_`, whatever its value", () => {
	const out = frontmatterToPayloadFields({ id: IRE, name: "Ireena", ...SERVED, created_at: new Date("2026-10-20T10:00:00Z") }, "character");
	assert.deepEqual(out, { name: "Ireena" });
});

// --- the folder export -------------------------------------------------------------

test("★ the folder export writes the seven as the download wrote them, a null one as null; a note without them gets none", async () => {
	const { app, vault } = makeApp();
	await download(app, [
		upsert("character", { type: "character", id: IRE, name: "Ireena", ...SERVED }),
		upsert("character", { type: "character", id: STRAHD, name: "Strahd", ...SERVED_OWNER }),
	], 41);
	await vault.seed("OnlyWorlds/Worlds/Barovia/Elements/Character/Kasimir.md", `---\nname: Kasimir\nid: 019e0000-0000-7000-8000-0000000006c3\n---\n\n### Description\n\n`);
	const plan = await (new ExportFolderCommand(app as never) as unknown as { planFiles(w: string, id: string): Promise<{ files: { rel: string; content: string }[] }> }).planFiles("Barovia", WID);
	const bodies = plan.files.filter((f) => f.rel.startsWith("elements/")).map((f) => JSON.parse(f.content) as Record<string, unknown>);
	const pick = (id: string, b: Record<string, unknown> | undefined) => Object.fromEntries(SERVER_FIELDS.filter((k) => b && k in b).map((k) => [k, b![k]]));
	assert.deepEqual(pick(IRE, bodies.find((b) => b.id === IRE)), SERVED);
	assert.deepEqual(pick(STRAHD, bodies.find((b) => b.id === STRAHD)), SERVED_OWNER);
	assert.deepEqual(pick("", bodies.find((b) => b.name === "Kasimir")), {}, "a timestamp was minted for a note made in the vault");
});

test("folderServerFields: all seven for a whole note that carries any, only its own for a known-of stub, none for none", () => {
	assert.deepEqual(folderServerFields({}), {});
	assert.deepEqual(folderServerFields({ change_seq: 3 }), {
		created_at: null, updated_at: null, change_seq: 3, created_by: null, changed_by: null, changed_via: null, changed_client: null,
	});
	assert.deepEqual(folderServerFields({ change_seq: 3, created_at: "t" }, true), { change_seq: 3, created_at: "t" });
});
