/**
 * An exported folder is the same world, not a new one (3.8.0, Fix 2; Kael's
 * measurement 2026-10-22, compare.md rule 6: Moppetopia's export carried a
 * minted id, 7 of the 18 keys GET /world served, and no provenance line).
 *
 * Download now records the server world in the world folder (its id in the id
 * marker, GET /world's body in the folder sidecar's `server` block); the
 * folder export starts from it, keeps the server id, and writes `source` and
 * the producer line (spec §4.1, §4.2). A world made in the vault mints, and
 * the export's report says so. Run against the REAL Download and Export
 * through the in-memory vault.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, setRequestUrl, __modals, type MockVault } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";

const WID = "0695db52-5433-7332-8000-db7fe10da375";
const PIN_ID = "019e0000-0000-7000-8000-0000000000a1";
const MINTED = "01a16305-5852-7cc5-897f-7319e777bdfb";

/** GET /world for Moppetopia as keel served it to Kael's run (plugin-download/http/001), keys in order. */
const WORLD = {
	id: WID,
	name: "Moppetopia",
	description: "Felt sailors, a water world.",
	image_url: "https://media.onlyworlds.com/worlds/moppetopia/maps/moppetopia-space-v2.webp",
	time_format_names: [],
	time_format_equivalents: [],
	time_basic_unit: "Year",
	time_range_min: 0,
	time_range_max: 500,
	time_range_current: 453,
	length_unit: "",
	mass_unit: "",
	distance_unit: "",
	public_read: true,
	agent_narrator_rule: false,
	owner_character: null,
	created_at: "2026-01-07T01:21:41.262478+00:00",
	updated_at: "2026-10-11T11:53:28.489198+00:00",
};

const MANIFEST = { id: "onlyworlds-builder", version: "3.8.0" };

function serve() {
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: WORLD };
		if (path === "/changes") {
			return {
				status: 200,
				json: {
					cursor: "c1", has_more: false, head: 1,
					changes: [{ op: "upsert", type: "pin", id: PIN_ID, change_seq: 1, updated_at: "x", element: { id: PIN_ID, name: "Crumblefields" } }],
				},
			};
		}
		return { status: 404, json: {} };
	});
}

const plugin = () => ({ settings: { syncCursors: {} as Record<string, unknown> }, saveSettings: async () => {}, manifest: MANIFEST });

/** Export `world` into the vault through the real command; the written world.json and the report modal. */
async function exportWorld(app: App, vault: MockVault, world: string, host: unknown) {
	__modals.length = 0;
	const before = new Set(vault.files.keys());
	const cmd = new ExportFolderCommand(app, host as never) as unknown as {
		exportWorld(world: string, dest: { kind: "vault" }): Promise<void>;
	};
	await cmd.exportWorld(world, { kind: "vault" });
	const worldJson = [...vault.files].find(([p]) => !before.has(p) && p.startsWith("OW-folder-export/") && p.endsWith("/world.json"));
	assert.ok(worldJson, "no world.json exported");
	const report = __modals.find((m) => m.constructor.name === "ExportReportModal") as unknown as { idNote: string | null } | undefined;
	assert.ok(report, "no export report");
	return { world: JSON.parse(worldJson[1].content) as Record<string, unknown>, folder: worldJson[0], idNote: report.idNote };
}

test("★ an export of a downloaded world carries the server id, every key GET /world served, `source` and the producer line", async () => {
	const { app, vault } = makeApp();
	serve();
	const host = plugin();
	await new DownloadWorldCommand(app, MANIFEST, host as never).downloadWithKey("ow_k_test", "");
	const { world, folder, idNote } = await exportWorld(app, vault, "Moppetopia", host);

	assert.equal(world.id, WID);
	assert.match(folder, /^OW-folder-export\/moppetopia-0695db52\//);
	assert.equal(idNote, null, "a downloaded world's export mints nothing and says nothing about its id");
	const source = world.source as Record<string, unknown>;
	assert.equal(source.server, "https://www.onlyworlds.com");
	assert.equal(source.world, WID);
	assert.ok(typeof source.at === "string" && !Number.isNaN(Date.parse(source.at)), `source.at: ${String(source.at)}`);
	assert.deepEqual(world.producer, { tool: "onlyworlds-builder", version: "3.8.0", input: "obsidian-vault" });
	assert.equal(world.format_version, "0.3.14");
	// the provenance this writer cannot know is absent, never guessed
	for (const k of ["exported_as", "snapshot_of", "api", "api_key"]) assert.equal(k in world, false, `${k} written`);

	// every key the server served, in its order, `time_range_current` as the schema's `time_current` (spec §5)
	const { time_range_current, ...rest } = WORLD;
	const expected: Record<string, unknown> = {};
	for (const [k, v] of Object.entries({ ...rest, time_current: time_range_current })) expected[k] = v;
	const served = Object.keys(WORLD).map((k) => (k === "time_range_current" ? "time_current" : k));
	assert.deepEqual(Object.keys(world).slice(0, served.length), served);
	for (const [k, v] of Object.entries(expected)) assert.deepEqual(world[k], v, k);
	assert.deepEqual(Object.keys(world).slice(served.length), ["source", "producer", "format_version"]);
});

test("an edit in a downloaded world's World.md travels; the other keys stay as the server served them", async () => {
	const { app, vault } = makeApp();
	serve();
	const host = plugin();
	await new DownloadWorldCommand(app, MANIFEST, host as never).downloadWithKey("ow_k_test", "");
	const md = "OnlyWorlds/Worlds/Moppetopia/World.md";
	vault.files.get(md)!.content = (vault.contentAt(md) ?? "")
		.replace(/^- \*\*Current Time:\*\* 453$/m, "- **Current Time:** 460")
		.replace(/^- \*\*Mass Unit:\*\* *$/m, "- **Mass Unit:** kg");
	const { world } = await exportWorld(app, vault, "Moppetopia", host);
	assert.equal(world.time_current, 460);
	assert.equal(world.mass_unit, "kg");
	assert.equal(world.length_unit, "");
	assert.equal(world.image_url, WORLD.image_url);
});

test("★ a world downloaded and exported under 3.7.0 (a minted id in its marker) exports the server id after its next download", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Moppetopia/World.md", "# World Overview: Moppetopia\n\n- **API Key:** ow_k_test\n");
	vault.dotfiles.set("OnlyWorlds/Worlds/Moppetopia/.ow-world-id", `world_id: ${MINTED}\nOnlyWorlds folder identity marker (do not edit).\n`);
	const host = plugin();
	await vault.seed("OnlyWorlds/Worlds/Moppetopia/Elements/Pin/Crumblefields.md", `---\nname: Crumblefields\nid: ${PIN_ID}\n---\n`);
	// before the download: the old id, and the report says how to keep the server's
	const before = await exportWorld(app, vault, "Moppetopia", host);
	assert.equal(before.world.id, MINTED);
	assert.match(String(before.idNote), /download the world again/);
	for (const p of [...vault.files.keys()]) if (p.startsWith("OW-folder-export/")) vault.files.delete(p);
	for (const p of [...vault.folders.keys()]) if (p.startsWith("OW-folder-export")) vault.folders.delete(p);

	serve();
	await new DownloadWorldCommand(app, MANIFEST, host as never).downloadWithKey("ow_k_test", "");
	const after = await exportWorld(app, vault, "Moppetopia", host);
	assert.equal(after.world.id, WID);
	assert.equal(after.idNote, null);
	assert.match(vault.dotfiles.get("OnlyWorlds/Worlds/Moppetopia/.ow-world-id") ?? "", new RegExp(`world_id: ${WID}`));
});

test("★ a world made in the vault mints its id, and the export's report says so", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Native/World.md", "# World Overview: Native\n\n- **API Key:** local\n- **Name:** Native\n");
	await vault.seed("OnlyWorlds/Worlds/Native/Elements/Character/Ireena.md", `---\nname: Ireena\nid: ${PIN_ID}\n---\n`);
	const { world, idNote } = await exportWorld(app, vault, "Native", plugin());
	assert.match(String(world.id), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	assert.equal(idNote, "New world id: this world has no server id in this vault.");
	assert.deepEqual(world.producer, { tool: "onlyworlds-builder", version: "3.8.0", input: "obsidian-vault" });
	assert.equal("source" in world, false, "a world made in the vault names no server");
	// a second export keeps the id it minted, and mints nothing more
	for (const p of [...vault.files.keys()]) if (p.startsWith("OW-folder-export/")) vault.files.delete(p);
	for (const p of [...vault.folders.keys()]) if (p.startsWith("OW-folder-export")) vault.folders.delete(p);
	const again = await exportWorld(app, vault, "Native", plugin());
	assert.equal(again.world.id, world.id);
	assert.equal(again.idNote, null);
});

// --- exported_as from GET /me (3.8.1, OW Obsidian #557 Fix 3; spec §4.2, v0.3.9) ----

const CHAR_ID = "019e0000-0000-7000-8000-0000000000c7";

/** keel for Moppetopia with a /me answer and a Character in the feed; every request recorded. */
function serveWithMe(me: Record<string, unknown> | null) {
	const seen: string[] = [];
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		seen.push(`${r.method} ${path}`);
		if (path === "/world") return { status: 200, json: WORLD };
		if (path === "/me") return me ? { status: 200, json: me } : { status: 404, json: {} };
		if (path === "/changes") {
			return {
				status: 200,
				json: {
					cursor: "c1", has_more: false, head: 2,
					changes: [
						{ op: "upsert", type: "pin", id: PIN_ID, change_seq: 1, updated_at: "x", element: { id: PIN_ID, name: "Crumblefields" } },
						{ op: "upsert", type: "character", id: CHAR_ID, change_seq: 2, updated_at: "x", element: { id: CHAR_ID, name: "Ireena" } },
					],
				},
			};
		}
		return { status: 404, json: {} };
	});
	return seen;
}

const ME = (fields: Record<string, unknown>) => ({ world: { id: WID, name: "Moppetopia" }, scope: "write", membership: null, character: null, ...fields });

test("★ an export with a key carries exported_as from GET /me: the owner's whole world", async () => {
	const { app, vault } = makeApp();
	const seen = serveWithMe(ME({ kind: "owner", role: "owner" }));
	const host = plugin();
	await new DownloadWorldCommand(app, MANIFEST, host as never).downloadWithKey("ow_k_test", "");
	const { world } = await exportWorld(app, vault, "Moppetopia", host);
	assert.deepEqual(world.exported_as, { kind: "owner", role: "owner", character: null });
	assert.equal(seen.filter((s) => s === "GET /me").length, 1, "one /me");
	assert.equal(world.format_version, "0.3.14");
	assert.deepEqual(Object.keys(world).slice(-4), ["source", "exported_as", "producer", "format_version"]);
});

test("★ exported_as: a co-builder is a member with its role; a guest is the Character it reads as, named as its note names it", async () => {
	for (const [me, expected] of [
		[ME({ kind: "person", role: "co_builder", membership: "m1" }), { kind: "member", role: "co_builder", character: null }],
		[ME({ kind: "person", role: "contributor", membership: "m2" }), { kind: "member", role: "contributor", character: null }],
		[ME({ kind: "player", role: "guest", membership: "m3", character: CHAR_ID, scope: "read" }), { kind: "character", role: "guest", character: { id: CHAR_ID, name: "Ireena" } }],
		[ME({ kind: "agent", role: "guest", membership: "m4", character: null }), { kind: "character", role: "guest", character: null }],
	] as const) {
		const { app, vault } = makeApp();
		serveWithMe(me as Record<string, unknown>);
		const host = plugin();
		await new DownloadWorldCommand(app, MANIFEST, host as never).downloadWithKey("ow_k_test", "");
		const { world } = await exportWorld(app, vault, "Moppetopia", host);
		assert.deepEqual(world.exported_as, expected, JSON.stringify(me));
	}
});

test("exported_as: an answer the spec does not map, or for another world, writes none (never guessed)", async () => {
	for (const me of [ME({ kind: "person", role: "steward" }), { ...ME({ kind: "owner", role: "owner" }), world: { id: MINTED, name: "Other" } }]) {
		const { app, vault } = makeApp();
		serveWithMe(me);
		const host = plugin();
		await new DownloadWorldCommand(app, MANIFEST, host as never).downloadWithKey("ow_k_test", "");
		const { world } = await exportWorld(app, vault, "Moppetopia", host);
		assert.equal("exported_as" in world, false, JSON.stringify(me));
	}
});

test("★ without a key, an export writes no exported_as, asks nothing and says nothing", async () => {
	const { app, vault } = makeApp();
	const seen = serveWithMe(ME({ kind: "owner", role: "owner" }));
	const host = plugin();
	await new DownloadWorldCommand(app, MANIFEST, host as never).downloadWithKey("ow_k_test", "");
	// The key leaves World.md: a folder opened with none.
	const md = "OnlyWorlds/Worlds/Moppetopia/World.md";
	vault.files.get(md)!.content = (vault.contentAt(md) ?? "").replace(/^- \*\*API Key:\*\*.*$/m, "- **API Key:** ");
	seen.length = 0;
	const { world, idNote } = await exportWorld(app, vault, "Moppetopia", host);
	assert.equal("exported_as" in world, false);
	assert.deepEqual(seen.filter((s) => s === "GET /me"), [], "no /me without a key");
	assert.equal(idNote, null);
	assert.equal(world.format_version, "0.3.14");
	// A world made in the vault (a local world) asks nothing either.
	const local = makeApp();
	await local.vault.seed("OnlyWorlds/Worlds/Native/World.md", "# World Overview: Native\n\n- **API Key:** local\n");
	await local.vault.seed("OnlyWorlds/Worlds/Native/Elements/Character/Ireena.md", `---\nname: Ireena\nid: ${CHAR_ID}\n---\n`);
	seen.length = 0;
	const native = await exportWorld(local.app, local.vault, "Native", plugin());
	assert.equal("exported_as" in native.world, false);
	assert.deepEqual(seen, []);
});
