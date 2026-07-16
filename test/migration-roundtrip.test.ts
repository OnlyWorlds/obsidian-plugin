/**
 * R9 — writer-minted migration fixtures + round-trip.
 *
 * These fixtures are produced by the REAL old write path (real handlebars, real
 * linkify/formatArray helpers, real [[id]]->[[Name]] rewrite) — see
 * test/span-writer.ts and its DISCLOSURE. We then run each minted note through
 * the migration transform and the frontmatter reader and assert the data
 * survives round-trip.
 *
 * Two round-trips, because they exercise different data classes:
 *   A. Span migration: writer span note -> parseSpanNote -> spanFieldsToFrontmatter
 *      -> frontmatterToPayloadFields  ==  the source data (links resolved back to
 *      ids). Covers apostrophe (HTML-entity class) and comma-in-linked-name
 *      (comma-join class).
 *   B. Extension preservation: an API object carrying atlas_/x_ fields the OLD
 *      writer dropped -> apiDataToFrontmatter -> frontmatterToPayloadFields
 *      keeps them verbatim. (The span note never held these; they live on the
 *      API object, so this is the writeElement/readElement round-trip modeled
 *      purely.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mintSpanNote, sanitizeFileName } from "./span-writer";
import {
	parseSpanNote,
	spanFieldsToFrontmatter,
	frontmatterToPayloadFields,
	apiDataToFrontmatter,
	bodyFieldForCategory,
} from "../vault/element-transform";

/**
 * Full migration of one minted span note to an API-shaped payload, mirroring
 * MigrateWorldCommand + readElement: span -> frontmatter (+ separated body) ->
 * payload with the body folded back into its description/story field.
 */
function migrate(
	category: string,
	note: string,
	resolve: (name: string) => string | null
): Record<string, unknown> {
	const parsed = parseSpanNote(note);
	const { frontmatter, bodyValue } = spanFieldsToFrontmatter(parsed, category, resolve);
	const payload = frontmatterToPayloadFields(frontmatter, category);
	if (parsed.id) payload.id = parsed.id;
	if (bodyValue) payload[bodyFieldForCategory(category)] = bodyValue;
	return payload;
}

// A resolver built from an id->name index (invert it): the on-disk note carries
// [[sanitize(Name)]], so migration must map that back to the id.
function resolverFromIndex(nameIndex: Record<string, string>): (name: string) => string | null {
	const byName = new Map<string, string>();
	for (const [id, name] of Object.entries(nameIndex)) {
		byName.set(name, id);
		byName.set(sanitizeFileName(name), id);
	}
	return (name: string) => byName.get(name) ?? null;
}

test("A1: Character with multi-link fields survives writer -> migrate -> payload", () => {
	const nameIndex = {
		"sp-human": "Human",
		"tr-brave": "Brave",
		"tr-cunning": "Cunning",
		"loc-windhaven": "Windhaven",
		"obj-blade": "Storm Blade",
		"fam-stormwind": "House Stormwind",
	};
	const source = {
		id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5b",
		name: "Aria Stormwind",
		description: "A knight of the storm coast.",
		supertype: "NPC",
		physicality: "Tall, weathered.",
		species: ["sp-human"],
		traits: ["tr-brave", "tr-cunning"],
		height: 172,
		birthplace: "loc-windhaven",
		location: "loc-windhaven",
		objects: ["obj-blade"],
		family: ["fam-stormwind"],
		str: 14,
		image_url: "",
	};
	const note = mintSpanNote("character", source, nameIndex);
	const got = migrate("character", note, resolverFromIndex(nameIndex));

	assert.equal(got.id, source.id);
	assert.equal(got.name, "Aria Stormwind");
	assert.equal(got.description, "A knight of the storm coast.");
	assert.equal(got.supertype, "NPC");
	assert.equal(got.physicality, "Tall, weathered.");
	assert.deepEqual(got.species, ["sp-human"]);
	assert.deepEqual(got.traits, ["tr-brave", "tr-cunning"]);
	assert.equal(got.height, 172);
	assert.equal(got.birthplace, "loc-windhaven"); // single link resolved
	assert.equal(got.location, "loc-windhaven");
	assert.deepEqual(got.objects, ["obj-blade"]);
	assert.deepEqual(got.family, ["fam-stormwind"]);
	assert.equal(got.STR, 14); // Str span -> uppercase TTRPG key
});

test("A2: Narrative body maps to story (not description) through migration", () => {
	const nameIndex = { "ch-aria": "Aria Stormwind" };
	const source = {
		id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a60",
		name: "The Gathering Storm",
		description: "Chapter one.",
		supertype: "Chapter",
		story: "The clouds broke over Windhaven at dawn.",
		characters: ["ch-aria"],
		image_url: "",
	};
	const note = mintSpanNote("narrative", source, nameIndex);
	const got = migrate("narrative", note, resolverFromIndex(nameIndex));

	assert.equal(got.id, source.id);
	assert.equal(got.name, "The Gathering Storm");
	assert.equal(got.story, "The clouds broke over Windhaven at dawn."); // body -> story
	assert.equal(got.description, "Chapter one."); // description stays a field
	assert.deepEqual(got.characters, ["ch-aria"]);
});

test("A3: apostrophe in name — pre-2.2.2 escaped writer decodes cleanly (HTML-entity class)", () => {
	// The OLD (pre-noEscape) writer HTML-escaped values: "The Kid's Family" landed
	// on disk as "The Kid&#x27;s Family". Migration must decode it back.
	const source = {
		id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a61",
		name: "The Kid's Family",
		description: "They don't forgive.",
		image_url: "",
	};
	const escapedNote = mintSpanNote("narrative", source, {}, { escape: true });
	// Prove the fixture is genuinely the escaped form (else the test is vacuous).
	assert.ok(escapedNote.includes("&#x27;") || escapedNote.includes("&#39;"), "fixture must be HTML-escaped");

	const got = migrate("narrative", escapedNote, () => null);
	assert.equal(got.name, "The Kid's Family"); // decoded, not "The Kid&#x27;s Family"
	assert.equal(got.description, "They don't forgive.");
});

test("A4: comma in a linked element's name does not corrupt the multi-link list (comma-join class)", () => {
	// A linked Family named "Volkov, House of" — the classic comma-join corruption:
	// the OLD multi-value join was comma-separated with no escaping. But on disk the
	// value is [[sanitize(Name)]] wikilinks, and migration extracts links by [[...]]
	// boundaries, not by splitting on commas — so the comma inside the name is safe.
	const nameIndex = {
		"fam-volkov": "Volkov, House of",
		"fam-drake": "Drake",
	};
	const source = {
		id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a62",
		name: "Ireena",
		family: ["fam-volkov", "fam-drake"],
		image_url: "",
	};
	const note = mintSpanNote("character", source, nameIndex);
	// The on-disk note must contain the comma-bearing wikilink verbatim.
	assert.ok(note.includes("[[Volkov, House of]]"), "wikilink must carry the comma-in-name");

	const got = migrate("character", note, resolverFromIndex(nameIndex));
	assert.deepEqual(got.family, ["fam-volkov", "fam-drake"]); // both resolved, none split
});

test("B: extension fields the old writer dropped survive the API-object round-trip", () => {
	// Extension namespaces were fetched-and-dropped by the pre-Phase-B reader, so
	// they never reached the span note. They live on the API object; the frontmatter
	// writer/reader must round-trip them verbatim (R3). Modeled with the pure fns
	// that back writeElement/readElement.
	const apiObject = {
		id: "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a63",
		name: "Aria Stormwind",
		description: "goes to the body",
		traits: ["tr-brave"],
		atlas_richtext_json: { doc: { type: "doc", content: [] } },
		atlas_color: "#3366ff",
		x_obsidian_pinned: true,
		shadow_age: { years: 31 },
	};
	// Write to frontmatter (API -> note), then read back (note -> API payload).
	const fm = apiDataToFrontmatter(apiObject, "character", apiObject.id);
	// description is the body, excluded from frontmatter; re-add it as the reader would.
	const body = "goes to the body";
	const readBack = frontmatterToPayloadFields(fm, "character");
	readBack[bodyFieldForCategory("character")] = body;

	assert.equal(readBack.name, "Aria Stormwind");
	assert.deepEqual(readBack.traits, ["tr-brave"]);
	assert.equal(readBack.description, "goes to the body");
	// The four extension keys survive verbatim through both directions.
	assert.deepEqual(readBack.atlas_richtext_json, { doc: { type: "doc", content: [] } });
	assert.equal(readBack.atlas_color, "#3366ff");
	assert.equal(readBack.x_obsidian_pinned, true);
	assert.deepEqual(readBack.shadow_age, { years: 31 });
});
