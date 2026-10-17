/**
 * Folder-format conformance (OW Infra #166, rows 5, 6, 13, 14), against the
 * REAL import and export commands through the in-memory vault
 * (test/support/obsidian-mock.ts). The law is the folder format spec
 * (Orrery `product/schema/folder-format-spec.md`): §3.2 filenames, §4 layout,
 * §4.1 world.json, §4.2 / §5 which keys a writer emits.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, __modals, __notices, type MockVault } from "./support/obsidian-mock";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { readElement, writeElement } from "../vault/element-file";
import { getCategorySchema } from "../vault/element-transform";

const WID = "0199b000-0000-7000-8000-0000000000aa";

/** A world.json carrying every key §4.1 and §4.2 name, plus a foreign one. */
const FULL_WORLD: Record<string, unknown> = {
	id: WID,
	name: "Barovia",
	description: "Land of mists.\nA second line of it.",
	image_url: "https://media.onlyworlds.com/barovia.png",
	created_at: "2026-01-01T10:00:00.000000Z",
	updated_at: "2026-02-01T10:00:00.000000Z",
	public_read: false,
	time_format_names: ["Age", "Year", "Month, long"],
	time_format_equivalents: ["Age", "Year", "Month"],
	time_basic_unit: "Year",
	time_range_min: -100,
	time_range_max: 735,
	time_current: 735,
	length_unit: "cm",
	mass_unit: "",
	distance_unit: "league",
	demo: false,
	format_version: "0.3.7",
	snapshot_of: "0199b000-0000-7000-8000-0000000000ff",
	snapshot_label: "ch05",
	snapshot_at: "2026-03-01T00:00:00.000Z",
	snapshot_change_seq: 4410,
	writable: false,
	snapshot_counts: { character: 1 },
	atlas_calendar: { eras: [{ name: "Old Earth", start: -100 }] },
};

const CHAR_ID = "0199b000-0000-7000-8000-0000000000c1";

async function seedFolder(vault: MockVault, dir: string, world: Record<string, unknown>, files: Record<string, unknown>) {
	await vault.seed(`${dir}/world.json`, JSON.stringify(world, null, 2) + "\n");
	for (const [rel, body] of Object.entries(files)) {
		await vault.seed(`${dir}/${rel}`, JSON.stringify(body, null, 2) + "\n");
	}
}

async function importDir(app: App, dir: string): Promise<void> {
	const cmd = new ImportFolderCommand(app) as unknown as { importFolder(dir: string): Promise<void> };
	await cmd.importFolder(dir);
}

/** Export `world` into the vault; return the written files, rel path -> content. */
async function exportWorld(app: App, vault: MockVault, world: string): Promise<Record<string, string>> {
	const before = new Set(vault.files.keys());
	const cmd = new ExportFolderCommand(app) as unknown as {
		exportWorld(world: string, dest: { kind: "vault" }): Promise<void>;
	};
	await cmd.exportWorld(world, { kind: "vault" });
	const out: Record<string, string> = {};
	for (const [p, e] of vault.files) {
		if (before.has(p) || !p.startsWith("OW-folder-export/")) continue;
		out[p.split("/").slice(2).join("/")] = e.content;
	}
	return out;
}

const CHAR_FILE = { id: CHAR_ID, type: "character", name: "Ireena", description: "A noble." };

// --- Row 5: world.json keeps every key through import and export ------------

test("row 5: import then export carries every world.json key, values and order unchanged", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", FULL_WORLD, { "elements/character/ireena--000000c1.json": CHAR_FILE });
	await importDir(app, "in/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	assert.ok(out["world.json"], "no world.json exported");
	// every key kept in place; format_version is this export's (every export is a birth)
	assert.equal(out["world.json"], JSON.stringify({ ...FULL_WORLD, format_version: "0.3.8" }, null, 2) + "\n");
});

test("row 5: the imported world gets a World.md showing its fields", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", FULL_WORLD, { "elements/character/ireena--000000c1.json": CHAR_FILE });
	await importDir(app, "in/barovia");
	const md = vault.contentAt("OnlyWorlds/Worlds/Barovia/World.md") ?? "";
	assert.match(md, /^- \*\*Current Time:\*\* 735$/m);
	assert.match(md, /^- \*\*Basic Time Unit:\*\* Year$/m);
	assert.match(md, /^- \*\*Length Unit:\*\* cm$/m);
	assert.match(md, /^- \*\*API Key:\*\* local$/m);
});

test("row 5: an edit made in World.md travels; untouched keys stay verbatim", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", FULL_WORLD, { "elements/character/ireena--000000c1.json": CHAR_FILE });
	await importDir(app, "in/barovia");
	const path = "OnlyWorlds/Worlds/Barovia/World.md";
	const md = vault.contentAt(path) ?? "";
	vault.files.get(path)!.content = md
		.replace(/^- \*\*Current Time:\*\* 735$/m, "- **Current Time:** 800")
		.replace(/^- \*\*Mass Unit:\*\* $/m, "- **Mass Unit:** kg");
	const world = JSON.parse((await exportWorld(app, vault, "Barovia"))["world.json"]);
	assert.equal(world.time_current, 800);
	assert.equal(world.mass_unit, "kg");
	assert.deepEqual(world.time_format_names, FULL_WORLD.time_format_names);
	assert.equal(world.description, FULL_WORLD.description);
	assert.deepEqual(Object.keys(world), Object.keys(FULL_WORLD));
});

test("row 5: a world.json spelling the wire's time_range_current is read, and exported as time_current in its place (§5, Kael 3.6)", async () => {
	const { app, vault } = makeApp();
	const wire = { id: WID, name: "Barovia", time_range_current: 12, time_basic_unit: "Year" };
	await seedFolder(vault, "in/barovia", wire, { "elements/character/ireena--000000c1.json": CHAR_FILE });
	await importDir(app, "in/barovia");
	assert.match(vault.contentAt("OnlyWorlds/Worlds/Barovia/World.md") ?? "", /^- \*\*Current Time:\*\* 12$/m);
	const out = await exportWorld(app, vault, "Barovia");
	// An export is a new folder, so it speaks the current dialect: the
	// schema's time_current, at the key's own position.
	const expected = { id: WID, name: "Barovia", time_current: 12, time_basic_unit: "Year", format_version: "0.3.8" };
	assert.equal(out["world.json"], JSON.stringify(expected, null, 2) + "\n");
	// An edit in World.md lands on time_current too.
	const md = "OnlyWorlds/Worlds/Barovia/World.md";
	vault.files.get(md)!.content = (vault.contentAt(md) ?? "").replace("- **Current Time:** 12", "- **Current Time:** 13");
	for (const p of [...vault.files.keys()]) if (p.startsWith("OW-folder-export/")) vault.files.delete(p);
	for (const p of [...vault.folders.keys()]) if (p.startsWith("OW-folder-export")) vault.folders.delete(p);
	const edited = JSON.parse((await exportWorld(app, vault, "Barovia"))["world.json"]);
	assert.equal(edited.time_current, 13);
	assert.equal("time_range_current" in edited, false);
});

test("row 5: the api block (a credential) is never kept in the vault nor exported: the export is a local world", async () => {
	const { app, vault } = makeApp();
	const linked = { id: WID, name: "Barovia", api: { world_id: WID, api_key: "ow_w_SECRET" }, time_current: 3 };
	await seedFolder(vault, "in/barovia", linked, { "elements/character/ireena--000000c1.json": CHAR_FILE });
	await importDir(app, "in/barovia");
	for (const [p, v] of [...vault.dotfiles, ...[...vault.files].map(([k, e]) => [k, e.content] as const)]) {
		if (p.startsWith("in/")) continue;
		assert.ok(!v.includes("ow_w_SECRET"), `${p} holds the key`);
	}
	const world = JSON.parse((await exportWorld(app, vault, "Barovia"))["world.json"]);
	assert.equal(world.api, undefined);
	assert.deepEqual(world, { id: WID, name: "Barovia", time_current: 3, format_version: "0.3.8" });
});

test("row 5: a world made in the vault exports its World.md time settings", async () => {
	const { app, vault } = makeApp();
	await vault.seed(
		"OnlyWorlds/Worlds/Native/World.md",
		[
			"",
			"# World Overview: Native",
			"",
			"## Core",
			"- **API Key:** local",
			"- **Name:** Native",
			"- **Description:** ",
			"- **Version:** 0.30.00",
			"- **Image:** None",
			"",
			"## Time Settings ",
			"- **Time Formats:** Eon,Era,Year",
			"- **Time Format Equivalents:** Eon,Era,Year",
			"- **Basic Time Unit:** Year",
			"- **Time Range Min:** 0",
			"- **Time Range Max:** 100",
			"- **Current Time:** 7",
			"",
			"## Units",
			"- **Length Unit:** m",
			"- **Mass Unit:** ",
			"- **Distance Unit:** ",
			"",
		].join("\n")
	);
	await vault.seed(
		"OnlyWorlds/Worlds/Native/Elements/Character/Ireena.md",
		`---\nname: Ireena\nid: ${CHAR_ID}\n---\n\n### Description\n\nA noble.\n`
	);
	const world = JSON.parse((await exportWorld(app, vault, "Native"))["world.json"]);
	assert.deepEqual(world.time_format_names, ["Eon", "Era", "Year"]);
	assert.deepEqual(world.time_format_equivalents, ["Eon", "Era", "Year"]);
	assert.equal(world.time_basic_unit, "Year");
	assert.equal(world.time_range_min, 0);
	assert.equal(world.time_range_max, 100);
	assert.equal(world.time_current, 7);
	assert.equal(world.length_unit, "m");
	assert.equal("mass_unit" in world, false, "an unset unit stays absent");
	assert.equal("description" in world, false);
});

// --- Row 6: export writes what the element carries, never a minted stamp ----

const NATIVE_MD = (name: string, id: string) => `---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\nA noble.\n`;

test("row 6: an element made in the vault exports with no timestamp invented (spec §4.1, §5)", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Native/World.md", "- **Name:** Native\n");
	await vault.seed("OnlyWorlds/Worlds/Native/Elements/Character/Ireena.md", NATIVE_MD("Ireena", CHAR_ID));
	const out = await exportWorld(app, vault, "Native");
	const rel = Object.keys(out).find((p) => p.startsWith("elements/character/"));
	assert.ok(rel, "no character file");
	const body = JSON.parse(out[rel]);
	for (const k of ["local_updated_at", "created_at", "updated_at", "server_updated_at", "change_seq"]) {
		assert.equal(k in body, false, `${k} was minted`);
	}
	assert.equal(body.type, "character");
	assert.equal(body.id, CHAR_ID);
});

test("row 6: server and sync fields an imported element carried come back out verbatim", async () => {
	const { app, vault } = makeApp();
	const carried = {
		created_at: "2026-01-02T03:04:05.123456Z",
		updated_at: "2026-01-03T03:04:05.123456Z",
		change_seq: 4401,
		created_by: null,
		local_updated_at: "2026-01-04T00:00:00.000Z",
		server_updated_at: "2026-01-03T03:04:05.123456Z",
		image_media_id: "m-77",
	};
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/character/ireena--000000c1.json": { ...CHAR_FILE, ...carried },
	});
	await importDir(app, "in/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	const rel = Object.keys(out).find((p) => p.startsWith("elements/character/"))!;
	const body = JSON.parse(out[rel]);
	for (const [k, v] of Object.entries(carried)) assert.deepEqual(body[k], v, k);
	// and nothing about them leaked into the note, where an upload would send them
	const note = [...vault.files.keys()].find((p) => p.includes("/Elements/Character/"))!;
	assert.ok(!/created_at|change_seq|updated_at/.test(vault.contentAt(note) ?? ""), "server fields in the note");
});

// --- Row 13: all 22 types under elements/<type>/ (spec §4) ------------------

const MAP_ID = "0199b000-0000-7000-8000-0000000000d1";
const PIN_ID = "0199b000-0000-7000-8000-0000000000d2";
const MARKER_ID = "0199b000-0000-7000-8000-0000000000d3";
const ZONE_ID = "0199b000-0000-7000-8000-0000000000d4";
const SPATIAL_FILES = (bucket: string): Record<string, unknown> => ({
	[`${bucket}/map/barovia--000000d1.json`]: { id: MAP_ID, type: "map", name: "Barovia", width: 1000, height: 800 },
	[`${bucket}/pin/ireena--000000d2.json`]: { id: PIN_ID, type: "pin", name: "Ireena", map: MAP_ID, x: 10, y: 20 },
	[`${bucket}/marker/tser-pool--000000d3.json`]: { id: MARKER_ID, type: "marker", name: "Tser Pool", map: MAP_ID, x: 5, y: 6 },
	[`${bucket}/zone/svalich-woods--000000d4.json`]: { id: ZONE_ID, type: "zone", name: "Svalich Woods" },
});

test("row 13: map, pin, marker and zone export under elements/<type>/, never spatial/", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, SPATIAL_FILES("elements"));
	await importDir(app, "in/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	const rels = Object.keys(out).filter((p) => p !== "world.json").sort();
	assert.equal(rels.length, 4);
	for (const t of ["map", "pin", "marker", "zone"]) {
		assert.ok(rels.some((p) => p.startsWith(`elements/${t}/`)), `no elements/${t}/ file: ${rels.join(", ")}`);
	}
	assert.ok(!rels.some((p) => p.startsWith("spatial/")), "a spatial/ path was written");
});

test("row 13: import still reads a legacy spatial/<type>/ folder (old exports on users' disks)", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/old", { id: WID, name: "Barovia" }, SPATIAL_FILES("spatial"));
	await importDir(app, "in/old");
	const notes = [...vault.files.keys()].filter((p) => p.startsWith("OnlyWorlds/Worlds/Barovia/Elements/"));
	for (const t of ["Map", "Pin", "Marker", "Zone"]) {
		assert.ok(notes.some((p) => p.includes(`/Elements/${t}/`)), `no ${t} note from spatial/`);
	}
});

// Temper (Atlas): Atlas serves the copy with the larger local_updated_at when an
// id sits in both spatial/ and elements/, so an old spatial/ file beside a new
// elements/ one would win forever. A mixed folder can only come from writing
// into an existing folder, and every export path refuses that.
async function seedNativeWorld(vault: MockVault): Promise<string> {
	await vault.seed("OnlyWorlds/Worlds/Native/World.md", "- **Name:** Native\n");
	await vault.seed(
		"OnlyWorlds/Worlds/Native/Elements/Pin/Ireena.md",
		`---\nname: Ireena\nid: ${PIN_ID}\n---\n\n### Description\n\nA pin.\n`
	);
	vault.dotfiles.set("OnlyWorlds/Worlds/Native/.ow-world-id", `world_id: ${WID}\n`);
	return "native-0199b000"; // worldFolderName("Native", WID)
}

test("row 13: export into the vault refuses a folder that already exists (holding spatial/pin/x.json); nothing written", async () => {
	const { app, vault } = makeApp();
	const folder = await seedNativeWorld(vault);
	await vault.seed(`OW-folder-export/${folder}/spatial/pin/x.json`, "{}\n");
	__notices.length = 0;
	const out = await exportWorld(app, vault, "Native");
	assert.deepEqual(out, {}, "files were written into an existing folder");
	assert.ok(__notices.some((n) => /already exists/.test(n)), "no refusal notice");
});

test("row 13: export to a desktop folder refuses a target that already exists (holding spatial/pin/x.json); nothing written", async () => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
	const fs = require("fs") as typeof import("fs");
	// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
	const path = require("path") as typeof import("path");
	const { app, vault } = makeApp();
	const folder = await seedNativeWorld(vault);
	// Inside the build output (test-dist), never outside the checkout.
	// eslint-disable-next-line no-undef
	const root = path.join(__dirname, `tmp-export-${process.pid}`);
	const existing = path.join(root, folder, "spatial", "pin");
	fs.mkdirSync(existing, { recursive: true });
	fs.writeFileSync(path.join(existing, "x.json"), "{}\n");
	try {
		__notices.length = 0;
		const cmd = new ExportFolderCommand(app) as unknown as {
			exportWorld(world: string, dest: { kind: "external"; dir: string }): Promise<void>;
		};
		await cmd.exportWorld("Native", { kind: "external", dir: root });
		const walk = (d: string): string[] =>
			fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(root, path.join(d, e.name))]
			);
		assert.deepEqual(walk(root), [path.join(folder, "spatial", "pin", "x.json")]);
		assert.ok(__notices.some((n) => /already exists/.test(n)), "no refusal notice");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// --- Row 14: filenames follow spec §3.2's RECOMMENDED profile ----------------

test("row 14: slug capped at 40, cut first and then a trailing hyphen stripped (§3.2)", async () => {
	const { app, vault } = makeApp();
	const long = "a".repeat(39) + " bcdefghijklmnopqrstuvwxyz and more words";
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/character/x.json": { id: CHAR_ID, type: "character", name: long },
	});
	await importDir(app, "in/barovia");
	const rels = Object.keys(await exportWorld(app, vault, "Barovia")).filter((p) => p !== "world.json");
	assert.deepEqual(rels, [`elements/character/${"a".repeat(39)}--000000c1.json`]);
});

test("row 14: an unsluggable name writes <full-id>.json (§3.2 guard)", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/character/x.json": { id: CHAR_ID, type: "character", name: "日本" },
	});
	await importDir(app, "in/barovia");
	const rels = Object.keys(await exportWorld(app, vault, "Barovia")).filter((p) => p !== "world.json");
	assert.deepEqual(rels, [`elements/character/${CHAR_ID}.json`]);
});

test("row 14: two same-named elements sharing a tail both survive: the lower id keeps the short name, the other falls back to the full id (§3.2 MUST)", async () => {
	const { app, vault } = makeApp();
	const lo = "0199b000-0000-7000-8000-1111000000e1";
	const hi = "0199b000-0000-7000-8000-2222000000e1"; // same last 8: 000000e1
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/pin/b.json": { id: hi, type: "pin", name: "Gate", x: 2 },
		"elements/pin/a.json": { id: lo, type: "pin", name: "Gate", x: 1 },
	});
	await importDir(app, "in/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	const rels = Object.keys(out).filter((p) => p !== "world.json").sort();
	assert.deepEqual(rels, [`elements/pin/gate--${hi}.json`, "elements/pin/gate--000000e1.json"].sort());
	assert.equal(JSON.parse(out["elements/pin/gate--000000e1.json"]).id, lo);
	assert.equal(JSON.parse(out[`elements/pin/gate--${hi}.json`]).id, hi);
});

test("row 14: import reads any filename; identity is the id inside (§3.1)", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/character/Hand Renamed (copy).json": { id: CHAR_ID, type: "character", name: "Ireena" },
	});
	await importDir(app, "in/barovia");
	assert.ok([...vault.files.keys()].some((p) => p.startsWith("OnlyWorlds/Worlds/Barovia/Elements/Character/")));
});

// --- The round trip: folder -> vault -> folder -> vault -> folder ------------

/** A folder with a full world.json and one element of each spatial type, server fields included. */
const ROUND_TRIP_FOLDER: Record<string, unknown> = {
	"elements/map/barovia--000000d1.json": {
		id: MAP_ID, name: "Barovia", description: "The valley.", supertype: "region", width: 1000, height: 800,
		created_at: "2026-01-01T00:00:00.000000Z", updated_at: "2026-01-05T00:00:00.000000Z", change_seq: 11, created_by: null,
	},
	"elements/pin/ireena--000000d2.json": {
		id: PIN_ID, name: "Ireena", map: MAP_ID, x: 10, y: 20,
		created_at: "2026-01-02T00:00:00.000000Z", updated_at: "2026-01-06T00:00:00.000000Z", change_seq: 12,
		local_updated_at: "2026-01-06T00:00:00.000Z", server_updated_at: "2026-01-06T00:00:00.000000Z",
	},
	"elements/marker/tser-pool--000000d3.json": {
		id: MARKER_ID, name: "Tser Pool", map: MAP_ID, zone: ZONE_ID, x: 5, y: 6, atlas_style: { color: "#336699", layer: 2 },
		created_at: "2026-01-03T00:00:00.000000Z", change_seq: 13,
	},
	"elements/zone/svalich-woods--000000d4.json": {
		id: ZONE_ID, name: "Svalich Woods", description: "Dark pines.", x_mood: "grim",
		created_at: "2026-01-04T00:00:00.000000Z", updated_at: "2026-01-07T00:00:00.000000Z", change_seq: 14,
	},
};

/**
 * The fixture as a complete source file, the server's shape: `type` and every
 * field of the type present, unset ones as the server serves them (the export
 * writes that shape, row 18), in a key order unlike the plugin's own (`id`
 * first, `type` last), so that a byte match proves key order as received
 * (spec §5, Kael's review).
 */
function completeSource(rel: string, src: Record<string, unknown>): Record<string, unknown> {
	const type = rel.split("/")[1];
	const out: Record<string, unknown> = { id: src.id };
	for (const [k, v] of Object.entries(src)) if (k !== "id") out[k] = v;
	for (const [k, v] of Object.entries(serverEmpty(type))) if (!(k in out)) out[k] = v;
	out.type = type;
	return out;
}

test("round trip: export, import, export again is byte-identical, and every key of the source survives", async () => {
	// F0 -> vault A -> F1
	const a = makeApp();
	const f0: Record<string, Record<string, unknown>> = {};
	for (const [rel, src] of Object.entries(ROUND_TRIP_FOLDER)) f0[rel] = completeSource(rel, src as Record<string, unknown>);
	await seedFolder(a.vault, "in/barovia", FULL_WORLD, f0);
	await importDir(a.app, "in/barovia");
	const f1 = await exportWorld(a.app, a.vault, "Barovia");

	// F1 -> vault B -> F2
	const b = makeApp();
	for (const [rel, content] of Object.entries(f1)) await b.vault.seed(`in/f1/${rel}`, content);
	await importDir(b.app, "in/f1");
	const f2 = await exportWorld(b.app, b.vault, "Barovia");

	assert.deepEqual(Object.keys(f2).sort(), Object.keys(f1).sort(), "a file appeared or vanished");
	for (const rel of Object.keys(f1)) assert.equal(f2[rel], f1[rel], `${rel} changed on the second pass`);

	// Every key the source carried, with its value.
	assert.equal(f1["world.json"], JSON.stringify({ ...FULL_WORLD, format_version: "0.3.8" }, null, 2) + "\n");
	const byId = new Map(Object.values(f1).map((c) => JSON.parse(c)).map((j) => [j.id, j]));
	for (const [rel, src] of Object.entries(ROUND_TRIP_FOLDER) as [string, Record<string, unknown>][]) {
		const got = byId.get(src.id);
		assert.ok(got, `${rel} lost`);
		for (const [k, v] of Object.entries(src)) assert.deepEqual(got[k], v, `${rel}: ${k}`);
		assert.equal(got.type, rel.split("/")[1]);
	}
	// spec §4 layout and §3.2 names, and no minted stamps on the way.
	assert.deepEqual(
		Object.keys(f1).sort(),
		["elements/map/barovia--000000d1.json", "elements/marker/tser-pool--000000d3.json",
			"elements/pin/ireena--000000d2.json", "elements/zone/svalich-woods--000000d4.json", "world.json"]
	);
	assert.equal("local_updated_at" in byId.get(MAP_ID), false);
	// Bytes, not just values: each element file is its source, key order as received.
	for (const [rel, src] of Object.entries(f0)) {
		assert.equal(f1[rel], JSON.stringify(src, null, 2) + "\n", `${rel}: not the source's bytes`);
	}
});

// --- Row 12: a tool's extension key is never shadowed as the user's x_ ------

const RICH = '{"type":"doc","content":[{"type":"paragraph","text":"Ireena: \\"the bride\\" # 1"}]}';

test("row 12: string atlas_color and atlas_richtext_json survive import -> save -> export unchanged, no x_ shadow, nothing extra in the payload", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/character/ireena--000000c1.json": { ...CHAR_FILE, atlas_color: "#8b0000", atlas_richtext_json: RICH, x_mood: "wary" },
	});
	await importDir(app, "in/barovia");
	const notePath = [...vault.files.keys()].find((p) => p.includes("/Elements/Character/"))!;
	const note = () => vault.contentAt(notePath) ?? "";
	assert.ok(!/^### (Color|Richtext Json)$/m.test(note()), "a tool's key became a body section");

	// Save: the user edits the body; the save path reads the note into its payload.
	vault.files.get(notePath)!.content = note().replace("A noble.", "A noble of Barovia.");
	const file = app.vault.getAbstractFileByPath(notePath) as unknown as import("obsidian").TFile;
	const read = await readElement(app, file);
	assert.ok(read);
	assert.equal(read.fields.atlas_color, "#8b0000");
	assert.equal(read.fields.atlas_richtext_json, RICH);
	assert.equal(read.fields.x_mood, "wary");
	assert.deepEqual(Object.keys(read.fields).filter((k) => k.startsWith("x_")), ["x_mood"], "an x_ shadow in the payload");
	await writeElement(app, "Barovia", "character", CHAR_ID, { ...read.fields, id: CHAR_ID, name: read.name });

	const out = await exportWorld(app, vault, "Barovia");
	const body = JSON.parse(out["elements/character/ireena--000000c1.json"]);
	assert.equal(body.atlas_color, "#8b0000");
	assert.equal(body.atlas_richtext_json, RICH);
	assert.equal(body.x_mood, "wary");
	assert.equal(body.description, "A noble of Barovia.");
	assert.deepEqual(Object.keys(body).filter((k) => k.startsWith("x_")), ["x_mood"]);
});

test("row 12: a note an older plugin wrote, with a '### Color' copy of atlas_color, reads no x_color and loses no prose", async () => {
	const { app, vault } = makeApp();
	const path = "OnlyWorlds/Worlds/W/Elements/Character/Ireena.md";
	await vault.seed(
		path,
		`---\nname: Ireena\nid: ${CHAR_ID}\natlas_color: "#8b0000"\n---\n\n### Description\n\nA noble.\n\n### Color\n\n#8b0000\n`
	);
	const read = await readElement(app, app.vault.getAbstractFileByPath(path) as unknown as import("obsidian").TFile);
	assert.ok(read);
	assert.equal(read.fields.atlas_color, "#8b0000");
	assert.equal("x_color" in read.fields, false);
	assert.equal(read.fields.description, "A noble.");
});

// --- format_version: written at a folder's birth (spec §4.2 row, v0.3.8) ----

test("format_version: a world made in the vault exports format_version 0.3.8", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Native/World.md", "- **Name:** Native\n");
	await vault.seed("OnlyWorlds/Worlds/Native/Elements/Character/Ireena.md", NATIVE_MD("Ireena", CHAR_ID));
	const world = JSON.parse((await exportWorld(app, vault, "Native"))["world.json"]);
	assert.equal(world.format_version, "0.3.8");
});

test("format_version: every export is a birth: 0.3.8 whether the source carried none or an older value", async () => {
	for (const [carried, expected] of [[undefined, "0.3.8"], ["0.3.6", "0.3.8"]] as const) {
		const { app, vault } = makeApp();
		const src: Record<string, unknown> = { id: WID, name: "Barovia" };
		if (carried) src.format_version = carried;
		await seedFolder(vault, "in/barovia", src, { "elements/character/ireena--000000c1.json": CHAR_FILE });
		await importDir(app, "in/barovia");
		const world = JSON.parse((await exportWorld(app, vault, "Barovia"))["world.json"]);
		assert.equal(world.format_version, expected, `source ${carried ?? "without one"}`);
	}
});

// --- v0.3.8 §4 "one id, one file": a reader serves the elements/ copy -------

test("import serves the elements/ copy of an id found in both layouts, and lists the duplicate (§4, Kael 3.5)", async () => {
	const { app, vault } = makeApp();
	__modals.length = 0;
	// The legacy spatial/ copy first, so getFiles() order alone would pick it.
	await seedFolder(vault, "in/mixed", { id: WID, name: "Barovia" }, {
		"spatial/pin/ireena--000000d2.json": { id: PIN_ID, type: "pin", name: "Old Ireena", local_updated_at: "2099-01-01T00:00:00.000Z" },
		"elements/pin/ireena--000000d2.json": { id: PIN_ID, type: "pin", name: "Ireena" },
	});
	await importDir(app, "in/mixed");
	const notes = [...vault.files.keys()].filter((p) => p.includes("/Elements/Pin/"));
	assert.equal(notes.length, 1);
	assert.match(vault.contentAt(notes[0]) ?? "", /^name: Ireena$/m);
	const report = __modals.find((m) => m.constructor.name === "ImportReportModal") as unknown as
		{ result: { duplicates: { id: string; read: string; ignored: string }[] } };
	assert.deepEqual(report.result.duplicates, [
		{ id: PIN_ID, read: "elements/pin/ireena--000000d2.json", ignored: "spatial/pin/ireena--000000d2.json" },
	]);
});

// --- Row 18: the export writes a field as the server serves it --------------

/** keel's serialize for an unset field: "" text, [] multi-link, null single link and number. */
function serverEmpty(type: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, def] of Object.entries(getCategorySchema(type) ?? {})) {
		out[k] = def.type === "multi_link" ? [] : def.type === "text" ? "" : null;
	}
	return out;
}

test("row 18: an imported element's empty values come back as the server serves them, none dropped", async () => {
	const { app, vault } = makeApp();
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/character/ireena--000000c1.json": {
			...CHAR_FILE, supertype: "", subtype: "", image_url: "", species: [], traits: [], birthplace: null, height: null, x_notes: null,
		},
	});
	await importDir(app, "in/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	const body = JSON.parse(out[Object.keys(out).find((p) => p.startsWith("elements/character/"))!]);
	for (const [k, v] of Object.entries(serverEmpty("character"))) {
		if (k === "name" || k === "description") continue;
		assert.ok(k in body, `${k} dropped`);
		assert.deepEqual(body[k], v, k);
	}
	assert.equal(body.x_notes, null, "an extension key read as null stays null");
});

test("row 18: an element made in the vault exports every field of its type, unset ones empty", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Native/World.md", "- **Name:** Native\n");
	await vault.seed("OnlyWorlds/Worlds/Native/Elements/Pin/Here.md", `---\nname: Here\nid: ${PIN_ID}\nx: 3\n---\n\n### Description\n\nA pin.\n`);
	const out = await exportWorld(app, vault, "Native");
	const body = JSON.parse(out[Object.keys(out).find((p) => p.startsWith("elements/pin/"))!]);
	assert.deepEqual(body, { ...serverEmpty("pin"), ...body }, "a value changed");
	assert.deepEqual(Object.keys(serverEmpty("pin")).filter((k) => !(k in body)), [], "fields missing");
	assert.equal(body.x, 3);
	assert.equal(body.y, null);
	assert.equal(body.element_id, null);
	assert.equal(body.element_type, "");
});

// --- Row 19: key order as received survives an edit between import and export

test("row 19: an imported element edited in its note still exports in its source's key order", async () => {
	const { app, vault } = makeApp();
	const src = {
		x_mood: "wary", id: CHAR_ID, background: "Born in Vallaki.", created_at: "2026-01-02T03:04:05.123456Z",
		name: "Ireena", description: "A noble.", type: "character", height: 170, traits: [], supertype: "noble",
	};
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, { "elements/character/ireena--000000c1.json": src });
	await importDir(app, "in/barovia");
	const note = [...vault.files.keys()].find((p) => p.includes("/Elements/Character/"))!;
	await vault.modify(vault.files.get(note)!.file, (vault.contentAt(note) ?? "").replace("A noble.", "A noble, now wed."));
	const out = await exportWorld(app, vault, "Barovia");
	const body = JSON.parse(out[Object.keys(out).find((p) => p.startsWith("elements/character/"))!]);
	assert.equal(body.description, "A noble, now wed.");
	assert.deepEqual(Object.keys(body).slice(0, Object.keys(src).length), Object.keys(src), "source keys reordered");
});

// --- Row 15: prose crosses import and export unaltered ----------------------

test("row 15: a description's mention label and an unresolved [[X]] survive import then export byte for byte", async () => {
	const { app, vault } = makeApp();
	const prose = `Ireena loves [ the count ](ow://character/${CHAR_ID}) but not [[Nobody Here]] or [[ Ghost | old ]].`;
	await seedFolder(vault, "in/barovia", { id: WID, name: "Barovia" }, {
		"elements/character/ireena--000000c1.json": { ...CHAR_FILE, description: prose },
	});
	await importDir(app, "in/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	const rel = Object.keys(out).find((p) => p.startsWith("elements/character/"))!;
	assert.equal(JSON.parse(out[rel]).description, prose);
});

void __modals;
