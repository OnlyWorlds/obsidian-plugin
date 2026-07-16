/**
 * S9 Phase C — OnlyWorlds folder bridge serializers.
 *
 * Two groups:
 *   R1: conformance pins for the four live-proven Atlas-ingest facts (folder.js).
 *   RT: one in-memory round-trip — build a small world -> export serializers ->
 *       import serializers -> object equality (ids, links, extension keys,
 *       story/description). This is the "deterministic both ways" guarantee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	SPATIAL_TYPES,
	slugify,
	idTail,
	filenameFor,
	worldFolderName,
	elementRelPath,
	wikilinksToOwMentions,
	owMentionsToWikilinks,
	buildFolderElementBody,
	parseFolderElementBody,
	isUuid,
	type ElementRef,
} from "../vault/folder-format";

const WID = "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5b";

// --- R1a: world.json id + name (exercised in the round-trip below; the pin here
// is that world identity is a real uuid the folder name derives from). ---------
test("R1a: world folder name = <slug>-<first 8 of world id>", () => {
	assert.equal(worldFolderName("Aria's Storm Coast", WID), "aria-s-storm-coast-018f2a3b");
	// id head is the FIRST 8 hex chars (dashes stripped), not the tail.
	assert.ok(worldFolderName("X", WID).endsWith("-018f2a3b"));
});

// --- R1b: spatial vs elements bucketing ---------------------------------------
test("R1b: spatial types bucket under spatial/, others under elements/", () => {
	assert.deepEqual([...SPATIAL_TYPES].sort(), ["map", "marker", "pin", "zone"]);
	const el = { id: WID, name: "Barovia" };
	assert.ok(elementRelPath("map", el).startsWith("spatial/map/"));
	assert.ok(elementRelPath("pin", el).startsWith("spatial/pin/"));
	assert.ok(elementRelPath("zone", el).startsWith("spatial/zone/"));
	assert.ok(elementRelPath("marker", el).startsWith("spatial/marker/"));
	assert.ok(elementRelPath("location", el).startsWith("elements/location/"));
	assert.ok(elementRelPath("character", el).startsWith("elements/character/"));
});

// --- R1c: body stamp keys (folder dialect only) -------------------------------
test("R1c: every element body carries type + local_updated_at + created_at", () => {
	const stamp = "2026-07-16T00:00:00.000Z";
	const body = buildFolderElementBody("character", { id: WID, name: "Aria", traits: ["t1"] }, stamp);
	assert.equal(body.type, "character");
	assert.equal(body.local_updated_at, stamp);
	assert.equal(body.created_at, stamp);
	// stamp keys lead the serialized object (folder.js order).
	assert.deepEqual(Object.keys(body).slice(0, 3), ["type", "local_updated_at", "created_at"]);
	// payload fields survive.
	assert.equal(body.name, "Aria");
	assert.deepEqual(body.traits, ["t1"]);
});

test("R1c: a stray type in the payload never overrides the true element type", () => {
	const body = buildFolderElementBody("location", { id: WID, name: "X", type: "wrong" }, "s");
	assert.equal(body.type, "location");
});

test("R1c: existing local_updated_at/created_at on the payload are preserved", () => {
	const body = buildFolderElementBody(
		"character",
		{ id: WID, name: "A", created_at: "2020-01-01T00:00:00.000Z" },
		"2026-07-16T00:00:00.000Z"
	);
	assert.equal(body.created_at, "2020-01-01T00:00:00.000Z"); // kept, not restamped
	assert.equal(body.local_updated_at, "2026-07-16T00:00:00.000Z"); // absent -> stamp
});

// --- R1d: filename = <slug>--<8-char id tail> ---------------------------------
test("R1d: element filename = <slug>--<8-char id tail>.json", () => {
	assert.equal(idTail(WID), "2e3f4a5b"); // last 8 hex, dashes stripped
	assert.equal(filenameFor("character", { id: WID, name: "Aria Stormwind" }), "aria-stormwind--2e3f4a5b.json");
	// no name -> type-prefixed fallback (folder.js).
	assert.equal(filenameFor("object", { id: WID, name: "" }), "object--2e3f4a5b.json");
});

test("slugify matches folder.js: lowercase, diacritic-strip, collapse, trim", () => {
	assert.equal(slugify("Château d'Amberville"), "chateau-d-amberville");
	assert.equal(slugify("  --Weird__Name!!  "), "weird-name");
	assert.equal(slugify("A".repeat(80)).length, 60); // max cap
});

// --- R3: ow:// <-> wikilink prose translation ---------------------------------
const REFS: ElementRef[] = [
	{ id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a01", name: "Strahd", type: "character" },
	{ id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a02", name: "Castle Ravenloft", type: "location" },
];
const byName = new Map(REFS.map((r) => [r.name, r]));
const byId = new Map(REFS.map((r) => [r.id, r]));
const resolveName = (n: string) => byName.get(n) ?? null;
const resolveId = (i: string) => byId.get(i) ?? null;

test("R3 export: resolvable [[wikilink]] -> ow:// mention; unresolvable stays literal", () => {
	const body = "See [[Strahd]] at [[Castle Ravenloft]], but [[Nobody Here]] is a ghost.";
	const out = wikilinksToOwMentions(body, resolveName);
	assert.ok(out.includes("[Strahd](ow://character/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a01)"));
	assert.ok(out.includes("[Castle Ravenloft](ow://location/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a02)"));
	assert.ok(out.includes("[[Nobody Here]]")); // literal preserved
});

test("R3 import: resolvable ow:// mention -> [[wikilink]]; unresolvable kept verbatim", () => {
	const body =
		"See [Strahd](ow://character/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a01) and " +
		"[Ghost](ow://creature/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4aff).";
	const out = owMentionsToWikilinks(body, resolveId);
	assert.ok(out.includes("[[Strahd]]"));
	assert.ok(out.includes("[Ghost](ow://creature/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4aff)")); // verbatim
});

test("R3: alias round-trips — [[Name|Label]] -> mention -> [[Name|Label]]", () => {
	const exported = wikilinksToOwMentions("The [[Strahd|Devil]] rides.", resolveName);
	assert.ok(exported.includes("[Devil](ow://character/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a01)"));
	const back = owMentionsToWikilinks(exported, resolveId);
	assert.ok(back.includes("[[Strahd|Devil]]")); // label preserved because it differs from name
});

test("R3: mention whose label already equals the name reduces to a bare wikilink", () => {
	const back = owMentionsToWikilinks(
		"[Strahd](ow://character/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a01)",
		resolveId
	);
	assert.equal(back, "[[Strahd]]");
});

test("isUuid gates world.json identity", () => {
	assert.ok(isUuid(WID));
	assert.ok(!isUuid("not-a-uuid"));
	assert.ok(!isUuid(undefined));
});

// --- RT: full in-memory round-trip -------------------------------------------
// Build a small world as API-shaped payloads, run the EXPORT serializers to
// produce folder JSON bodies + relative paths, then run the IMPORT serializers
// to recover API-shaped payloads, and assert object equality on the data that
// matters: ids, links, extension keys, story/description, prose references.
test("RT: world survives export serializers -> import serializers (object equality)", () => {
	const stamp = "2026-07-16T12:00:00.000Z";
	// The world: two characters, a location, a narrative (body=story), a map.
	const world = [
		{
			type: "character",
			payload: {
				id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a01",
				name: "Strahd",
				description: "The count of [[Castle Ravenloft]].",
				location: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a03",
				traits: ["018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a90"],
				atlas_color: "#8b0000",
				x_obsidian_pinned: true,
			},
		},
		{
			type: "location",
			payload: {
				id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a03",
				name: "Castle Ravenloft",
				description: "Home of [[Strahd]].",
				shadow_area: { km2: 4 },
			},
		},
		{
			type: "narrative",
			payload: {
				id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a04",
				name: "Prologue",
				story: "In the mists, [[Strahd]] waits.",
				description: "Opening.",
			},
		},
		{
			type: "map",
			payload: {
				id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a05",
				name: "Barovia",
			},
		},
	];

	// Name/id resolvers over the whole world (as the commands build from the vault).
	const refs: ElementRef[] = world.map((e) => ({
		id: e.payload.id,
		name: e.payload.name,
		type: e.type,
	}));
	const nameIdx = new Map(refs.map((r) => [r.name, r]));
	const idIdx = new Map(refs.map((r) => [r.id, r]));

	// The body field per type (mirrors bodyFieldForCategory: story for narrative).
	const bodyField = (t: string) => (t === "narrative" ? "story" : "description");

	// EXPORT: split body prose out, translate wikilinks, stamp folder body.
	const exported = world.map((e) => {
		const bf = bodyField(e.type);
		const payload = { ...e.payload } as Record<string, unknown>;
		// Only translate a body field the element actually carries — don't
		// materialize an empty one (mirrors the real export command).
		if (typeof payload[bf] === "string") {
			payload[bf] = wikilinksToOwMentions(payload[bf] as string, (n) => nameIdx.get(n) ?? null);
		}
		const body = buildFolderElementBody(e.type, payload, stamp);
		return { relPath: elementRelPath(e.type, e.payload), body };
	});

	// Conformance: spatial map bucketed, stamp keys present, filenames well-formed.
	const mapEntry = exported.find((x) => x.relPath.includes("/map/"))!;
	assert.ok(mapEntry.relPath.startsWith("spatial/map/"));
	for (const x of exported) {
		assert.equal(typeof x.body.type, "string");
		assert.equal(x.body.local_updated_at, stamp);
		assert.ok(/--[0-9a-f]{8}\.json$/.test(x.relPath));
	}

	// IMPORT: parse folder body back to (type, payload), translate ow:// back.
	const imported = exported.map((x) => {
		const fallbackType = x.relPath.split("/")[1]; // spatial|elements / <type> / file
		const { type, payload } = parseFolderElementBody(x.body, fallbackType);
		const bf = bodyField(type);
		if (typeof payload[bf] === "string") {
			payload[bf] = owMentionsToWikilinks(payload[bf] as string, (i) => idIdx.get(i) ?? null);
		}
		return { type, payload };
	});

	// Assert object equality against the source world.
	for (const src of world) {
		const got = imported.find((x) => (x.payload as any).id === src.payload.id)!;
		assert.equal(got.type, src.type, `type for ${src.payload.name}`);
		assert.deepEqual(got.payload, src.payload, `payload for ${src.payload.name}`);
	}
});
