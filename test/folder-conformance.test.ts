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
	assert.equal(out["world.json"], JSON.stringify(FULL_WORLD, null, 2) + "\n");
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

test("row 5: a world.json spelling the wire's time_range_current keeps that spelling (§5)", async () => {
	const { app, vault } = makeApp();
	const wire = { id: WID, name: "Barovia", time_range_current: 12, time_basic_unit: "Year" };
	await seedFolder(vault, "in/barovia", wire, { "elements/character/ireena--000000c1.json": CHAR_FILE });
	await importDir(app, "in/barovia");
	assert.match(vault.contentAt("OnlyWorlds/Worlds/Barovia/World.md") ?? "", /^- \*\*Current Time:\*\* 12$/m);
	const out = await exportWorld(app, vault, "Barovia");
	assert.equal(out["world.json"], JSON.stringify(wire, null, 2) + "\n");
});

test("row 5: the api block (a credential) is never kept in the vault nor exported (§4.1 portable copy)", async () => {
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
	assert.deepEqual(world, { id: WID, name: "Barovia", time_current: 3 });
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

void __modals;
