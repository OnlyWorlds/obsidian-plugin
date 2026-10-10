/**
 * World units (standard 00.31.00): length_unit, mass_unit, distance_unit.
 *
 * Three promises: World.md carries the three fields and reads them back; a
 * unit-bearing field shows the world's unit beside its number (bare when the
 * world set none); an upload sends the three fields as World.md holds them.
 * The Properties-panel decoration itself is Obsidian DOM and is checked in a
 * running vault; its decision (which field, which unit) is formatWithUnit/unitFor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Handlebars from "handlebars";
import { worldTemplateString } from "../Scripts/WorldDataTemplate";
import {
	UNIT_BEARING_FIELDS,
	WorldUnits,
	formatWithUnit,
	parseWorldUnits,
	pushWorldUnits,
	unitFor,
	upsertWorldUnits,
	worldUnitsPatch,
} from "../vault/world-units";

const renderWorld = (data: Record<string, unknown>) =>
	Handlebars.compile(worldTemplateString, { noEscape: true })(data);

const SERVER_WORLD = {
	name: "Gullwrack",
	api_key: "ow_w_test",
	description: "",
	version: "00.31.00",
	time_format_names: ["Year"],
	time_format_equivalents: [1],
	time_basic_unit: "Year",
	time_range_min: 0,
	time_range_max: 100,
	time_current: 0,
	length_unit: "cm",
	mass_unit: "stone",
	distance_unit: "leagues",
};

// --- World.md round trip ------------------------------------------------------

test("World.md written from a downloaded world carries the three unit lines", () => {
	const md = renderWorld(SERVER_WORLD);
	assert.match(md, /^- \*\*Length Unit:\*\* cm\r?$/m);
	assert.match(md, /^- \*\*Mass Unit:\*\* stone\r?$/m);
	assert.match(md, /^- \*\*Distance Unit:\*\* leagues\r?$/m);
});

test("World.md round-trips the three unit fields", () => {
	const md = renderWorld(SERVER_WORLD);
	assert.deepEqual(parseWorldUnits(md), { length_unit: "cm", mass_unit: "stone", distance_unit: "leagues" });
});

test("a new world's World.md carries the three lines, empty (not set)", () => {
	const md = renderWorld({ ...SERVER_WORLD, length_unit: undefined, mass_unit: undefined, distance_unit: undefined });
	assert.deepEqual(parseWorldUnits(md), { length_unit: "", mass_unit: "", distance_unit: "" });
});

test("a World.md from before 00.31.00 carries no unit keys at all", () => {
	const old = "## Core\n- **API Key:** ow_w_x\n- **Name:** Old\n\n## Time Settings \n- **Current Time:** 0\n";
	assert.deepEqual(parseWorldUnits(old), {});
});

test("a cleared line with its trailing space trimmed still reads as empty", () => {
	assert.deepEqual(parseWorldUnits("- **Mass Unit:**\n"), { mass_unit: "" });
});

test("download into an existing older World.md adds a Units section above the local-world prose", () => {
	const old =
		"# World Overview: W\n\n## Core\n- **API Key:** local\n- **Name:** W\n\n## Time Settings \n- **Current Time:** 0\n" +
		"\n## Local-only world\nThis world lives entirely in your vault.\n- run **Create World** and use **Take online**\n";
	const out = upsertWorldUnits(old, { length_unit: "ft", mass_unit: "lb", distance_unit: "mi" });
	assert.deepEqual(parseWorldUnits(out), { length_unit: "ft", mass_unit: "lb", distance_unit: "mi" });
	assert.ok(out.indexOf("## Units") < out.indexOf("## Local-only world"));
	assert.ok(out.indexOf("- **Current Time:** 0") < out.indexOf("## Units"));
	// the rest of the file is unchanged
	assert.equal(out.replace(/\n## Units\n(- \*\*\w+ Unit:\*\* \w+\n){3}/, ""), old);
});

test("download into a World.md that has the lines replaces them in place, and keeps CRLF", () => {
	const crlf = renderWorld(SERVER_WORLD).replace(/\r?\n/g, "\r\n");
	const out = upsertWorldUnits(crlf, { length_unit: "m", mass_unit: "", distance_unit: "km" });
	assert.deepEqual(parseWorldUnits(out), { length_unit: "m", mass_unit: "", distance_unit: "km" });
	assert.equal(out.split("\r\n").length, crlf.split("\r\n").length);
	assert.ok(!/[^\r]\n/.test(out), "no bare LF introduced");
	assert.equal(upsertWorldUnits(out, { length_unit: "m", mass_unit: "", distance_unit: "km" }), out);
});

test("an absent key in the server body leaves its line alone", () => {
	const md = renderWorld(SERVER_WORLD);
	assert.equal(upsertWorldUnits(md, {}), md);
	assert.equal(parseWorldUnits(upsertWorldUnits(md, { mass_unit: "kg" })).length_unit, "cm");
});

// --- rendering ------------------------------------------------------------------

test("the nine unit-bearing fields, as the standard 00.31.00 names them", () => {
	const pairs = Object.entries(UNIT_BEARING_FIELDS).flatMap(([cat, fields]) =>
		Object.entries(fields).map(([f, kind]) => `${cat}.${f}:${kind}`)
	);
	assert.deepEqual(pairs.sort(), [
		"ability.range:distance",
		"character.height:length",
		"character.weight:mass",
		"creature.height:length",
		"creature.speed:distance",
		"creature.weight:mass",
		"location.elevation:distance",
		"object.weight:mass",
		"species.weight:mass",
	]);
});

test("a unit-bearing field renders with the world's unit", () => {
	const units: WorldUnits = { length_unit: "cm", mass_unit: "kg", distance_unit: "ft" };
	assert.equal(formatWithUnit("Character", "height", 182, units), "182 cm");
	assert.equal(formatWithUnit("character", "weight", 74, units), "74 kg");
	assert.equal(formatWithUnit("Creature", "speed", 30, units), "30 ft");
	assert.equal(formatWithUnit("Location", "elevation", 0, units), "0 ft");
});

test("a unit-bearing field renders bare when the world's unit is unset", () => {
	assert.equal(formatWithUnit("Character", "height", 182, { length_unit: "" }), "182");
	assert.equal(formatWithUnit("Character", "height", 182, {}), "182");
	assert.equal(formatWithUnit("Character", "height", 182, { length_unit: "   " }), "182");
	assert.equal(unitFor("Object", "weight", {}), "");
});

test("a field without a unit never gets one, and an empty value shows no lone unit", () => {
	const units: WorldUnits = { length_unit: "cm", mass_unit: "kg", distance_unit: "ft" };
	assert.equal(formatWithUnit("Character", "charisma", 62, units), "62");
	assert.equal(formatWithUnit("Object", "height", 3, units), "3"); // Object has no height field
	assert.equal(formatWithUnit("Character", "height", null, units), "");
	assert.equal(formatWithUnit("Character", "height", "", units), "");
});

// --- upload ---------------------------------------------------------------------

function fakeClient(server: Record<string, unknown>) {
	const calls: { method: string; body?: Record<string, unknown> }[] = [];
	return {
		calls,
		async getWorld() {
			calls.push({ method: "GET" });
			return server;
		},
		async patchWorld(body: Record<string, unknown>) {
			calls.push({ method: "PATCH", body });
			return { ...server, ...body };
		},
	};
}

test("an upload sends the three fields unchanged", async () => {
	const local = parseWorldUnits(renderWorld({ ...SERVER_WORLD, length_unit: "hands", mass_unit: "stone (14 lb)", distance_unit: "leagues" }));
	const client = fakeClient({ length_unit: "", mass_unit: "", distance_unit: "" });
	const sent = await pushWorldUnits(client, local);
	assert.deepEqual(sent, { length_unit: "hands", mass_unit: "stone (14 lb)", distance_unit: "leagues" });
	assert.deepEqual(client.calls, [
		{ method: "GET" },
		{ method: "PATCH", body: { length_unit: "hands", mass_unit: "stone (14 lb)", distance_unit: "leagues" } },
	]);
});

test("an upload sends only the units that changed, and \"\" to clear one", () => {
	const patch = worldUnitsPatch(
		{ length_unit: "cm", mass_unit: "", distance_unit: "km" },
		{ length_unit: "cm", mass_unit: "kg", distance_unit: "mi" }
	);
	assert.deepEqual(patch, { mass_unit: "", distance_unit: "km" });
});

test("an upload with unchanged units sends no PATCH (owner-only route)", async () => {
	const client = fakeClient({ length_unit: "cm", mass_unit: "kg", distance_unit: null });
	const sent = await pushWorldUnits(client, { length_unit: "cm", mass_unit: "kg", distance_unit: "" });
	assert.deepEqual(sent, {});
	assert.deepEqual(client.calls, [{ method: "GET" }]);
});

test("an old World.md with no unit lines makes no world call at all", async () => {
	const client = fakeClient({ length_unit: "cm" });
	assert.deepEqual(await pushWorldUnits(client, {}), {});
	assert.deepEqual(client.calls, []);
});

test("a server body without the unit keys (older server) is never sent them", () => {
	assert.deepEqual(worldUnitsPatch({ length_unit: "cm", mass_unit: "kg", distance_unit: "m" }, { name: "W" }), {});
});
