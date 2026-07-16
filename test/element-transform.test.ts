/**
 * Pure-logic tests for the frontmatter flip (S9 Phase B).
 * Run under `node --test` after tsc compiles to test-dist/ (see npm test script).
 * No Obsidian imports — everything under test is pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isExtensionKey,
	normalizeLinkValue,
	bodyFieldForCategory,
	frontmatterToPayloadFields,
	apiDataToFrontmatter,
	parseSpanNote,
	spanFieldsToFrontmatter,
	spanLabelToKey,
	isSpanFormat,
	diffPayload,
	wikilinkTarget,
	toWikilink,
	isEmptyFieldValue,
} from "../vault/element-transform";

// --- A REAL Character span-format note, matching the upstream Handlebars grammar
// (CreateHandlebarsCommand.ts inline templates + obsidian_handlebars). This is the
// exact on-disk format the migration must read. ------------------------------
const CHARACTER_SPAN_NOTE = `## Base
- <span class="text-field" data-tooltip="Text">Name</span>: Ireena Kolyana
- <span class="text-field" data-tooltip="Text">Description</span>: A young woman of Barovia.
- <span class="text-field" data-tooltip="Text">Supertype</span>: NPC
- <span class="text-field" data-tooltip="Text">Subtype</span>: Ally

## Physical
- <span class="multi-link-field" data-tooltip="Multi Species">Species</span>: [[Human]]
- <span class="multi-link-field" data-tooltip="Multi Trait">Traits</span>: [[Brave]], [[Kind]]
- <span class="integer" data-tooltip="Number">Height</span>: 165

## World
- <span class="link-field" data-tooltip="Single Location">Location</span>: [[Village of Barovia]]
- <span class="integer" data-tooltip="Number">STR</span>: 10

- <span class="text-field" data-tooltip="Text">Id</span>: 018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b
- <span class="text-field" data-tooltip="Text">Image url</span>: None
`;

test("isExtensionKey recognizes the three namespaces and nothing else", () => {
	assert.ok(isExtensionKey("atlas_richtext_json"));
	assert.ok(isExtensionKey("shadow_age"));
	assert.ok(isExtensionKey("x_obsidian_pinned"));
	assert.ok(!isExtensionKey("description"));
	assert.ok(!isExtensionKey("atlasfoo")); // needs the underscore
	assert.ok(!isExtensionKey("name"));
});

test("bodyFieldForCategory maps narrative to story, everything else to description", () => {
	assert.equal(bodyFieldForCategory("narrative"), "story");
	assert.equal(bodyFieldForCategory("Narrative"), "story");
	assert.equal(bodyFieldForCategory("character"), "description");
	assert.equal(bodyFieldForCategory("Location"), "description");
});

test("normalizeLinkValue: single link collapses to one id or null", () => {
	assert.equal(normalizeLinkValue("abc", "single_link"), "abc");
	assert.equal(normalizeLinkValue(["abc", "def"], "single_link"), "abc");
	assert.equal(normalizeLinkValue({ id: "abc", name: "X" }, "single_link"), "abc");
	assert.equal(normalizeLinkValue("", "single_link"), null);
	assert.equal(normalizeLinkValue(null, "single_link"), null);
});

test("normalizeLinkValue: multi link becomes an array, never a comma string (R4)", () => {
	assert.deepEqual(normalizeLinkValue("a,b,c", "multi_link"), ["a", "b", "c"]);
	assert.deepEqual(normalizeLinkValue(["a", "b"], "multi_link"), ["a", "b"]);
	assert.deepEqual(
		normalizeLinkValue([{ id: "a" }, { id: "b" }], "multi_link"),
		["a", "b"]
	);
	assert.deepEqual(normalizeLinkValue(null, "multi_link"), []);
	assert.deepEqual(normalizeLinkValue("  ", "multi_link"), []);
});

test("frontmatterToPayloadFields keeps extension keys verbatim (R3)", () => {
	const fm = {
		id: "018f-...",
		name: "Ireena",
		species: "sp-1",
		traits: ["t-1", "t-2"],
		atlas_richtext_json: { doc: "..." },
		shadow_age: 21,
		x_obsidian_pinned: true,
		description: "body copy", // must be dropped (body owns it)
		world: "w-1", // must be dropped
		bogus_unknown: "drop me", // unknown non-extension key on a known type -> dropped
	};
	const out = frontmatterToPayloadFields(fm, "character");
	// species is multi_link in the SDK schema -> normalized to an array
	assert.deepEqual(out.species, ["sp-1"]);
	assert.deepEqual(out.traits, ["t-1", "t-2"]);
	assert.deepEqual(out.atlas_richtext_json, { doc: "..." });
	assert.equal(out.shadow_age, 21);
	assert.equal(out.x_obsidian_pinned, true);
	assert.ok(!("id" in out));
	assert.ok(!("world" in out));
	assert.ok(!("description" in out)); // body field excluded
	assert.ok(!("bogus_unknown" in out));
});

test("frontmatterToPayloadFields: narrative excludes story (body owns it), keeps description as a real field? no", () => {
	// For narrative, body maps to `story`, so `story` is excluded here and
	// `description` remains a normal schema field.
	const fm = { id: "n-1", name: "Ch1", story: "long prose", description: "summary" };
	const out = frontmatterToPayloadFields(fm, "narrative");
	assert.ok(!("story" in out));
	assert.equal(out.description, "summary");
});

test("apiDataToFrontmatter round-trips extension fields and normalizes links", () => {
	const data = {
		id: "018f-1",
		name: "Ireena",
		species: { id: "sp-1", name: "Human" }, // v1 stub
		traits: [{ id: "t-1" }, { id: "t-2" }],
		description: "goes to body",
		atlas_flag: "keep me",
		shadow_age: { years: 21 },
	};
	const fm = apiDataToFrontmatter(data, "character", "018f-1");
	assert.equal(fm.id, "018f-1");
	assert.equal(fm.name, "Ireena");
	assert.deepEqual(fm.species, ["sp-1"]); // multi_link
	assert.deepEqual(fm.traits, ["t-1", "t-2"]);
	assert.ok(!("description" in fm)); // body field
	assert.equal(fm.atlas_flag, "keep me");
	assert.deepEqual(fm.shadow_age, { years: 21 });
});

test("spanLabelToKey handles multiword, TTRPG stats, and image url", () => {
	assert.equal(spanLabelToKey("Name"), "name");
	assert.equal(spanLabelToKey("Image url"), "image_url");
	assert.equal(spanLabelToKey("Parent_map"), "parent_map");
	assert.equal(spanLabelToKey("STR"), "STR");
	assert.equal(spanLabelToKey("Str"), "STR");
});

test("isSpanFormat detects span markup", () => {
	assert.ok(isSpanFormat(CHARACTER_SPAN_NOTE));
	assert.ok(!isSpanFormat("---\nid: x\n---\nplain frontmatter note\n"));
});

test("parseSpanNote extracts id, name, typed fields, and wikilinks", () => {
	const parsed = parseSpanNote(CHARACTER_SPAN_NOTE);
	assert.equal(parsed.isSpanFormat, true);
	assert.equal(parsed.id, "018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b");
	assert.equal(parsed.name, "Ireena Kolyana");

	const byKey = Object.fromEntries(parsed.fields.map((f) => [f.key, f]));
	assert.equal(byKey.species.kind, "multi_link");
	assert.deepEqual(byKey.species.linkNames, ["Human"]);
	assert.equal(byKey.traits.kind, "multi_link");
	assert.deepEqual(byKey.traits.linkNames, ["Brave", "Kind"]);
	assert.equal(byKey.height.kind, "number");
	assert.equal(byKey.STR.kind, "number");
	assert.equal(byKey.description.kind, "text");
});

test("spanFieldsToFrontmatter resolves links to ids and separates the body (R1/R5)", () => {
	const parsed = parseSpanNote(CHARACTER_SPAN_NOTE);
	const index: Record<string, string> = {
		Human: "sp-human",
		Brave: "tr-brave",
		Kind: "tr-kind",
		"Village of Barovia": "loc-barovia",
	};
	const { frontmatter, bodyValue, unresolved } = spanFieldsToFrontmatter(
		parsed,
		"character",
		(n) => index[n] ?? null
	);

	assert.equal(frontmatter.id, "018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b");
	assert.equal(frontmatter.name, "Ireena Kolyana");
	assert.deepEqual(frontmatter.species, ["sp-human"]); // multi_link
	assert.deepEqual(frontmatter.traits, ["tr-brave", "tr-kind"]);
	assert.equal(frontmatter.location, "loc-barovia");
	assert.equal(frontmatter.height, 165);
	assert.equal(frontmatter.STR, 10);
	// description became the body, not a frontmatter field
	assert.equal(bodyValue, "A young woman of Barovia.");
	assert.ok(!("description" in frontmatter));
	// image_url was "None" -> null
	assert.equal(frontmatter.image_url, null);
	assert.deepEqual(unresolved, []);
});

test("spanFieldsToFrontmatter: unresolvable link names are reported, uuid names pass through", () => {
	const note = `- <span class="link-field" data-tooltip="Single Location">Location</span>: [[Ghost Town]]
- <span class="multi-link-field" data-tooltip="Multi Character">Friends</span>: [[018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b]]
- <span class="text-field" data-tooltip="Text">Id</span>: 018f0000-0000-7000-8000-000000000000
- <span class="text-field" data-tooltip="Text">Name</span>: Wanderer`;
	const parsed = parseSpanNote(note);
	const { frontmatter, unresolved } = spanFieldsToFrontmatter(parsed, "character", () => null);
	assert.equal(frontmatter.location, null); // unresolved single -> null
	assert.deepEqual(frontmatter.friends, ["018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b"]); // uuid passthrough
	assert.deepEqual(unresolved, ["Ghost Town"]);
});

test("narrative body maps to story on span parse", () => {
	const note = `- <span class="text-field" data-tooltip="Text">Name</span>: Chapter One
- <span class="text-field" data-tooltip="Text">Story</span>: Once upon a time in Barovia.
- <span class="text-field" data-tooltip="Text">Description</span>: The opening chapter.
- <span class="text-field" data-tooltip="Text">Id</span>: 018f0000-0000-7000-8000-000000000001`;
	const parsed = parseSpanNote(note);
	const { frontmatter, bodyValue } = spanFieldsToFrontmatter(parsed, "narrative", () => null);
	assert.equal(bodyValue, "Once upon a time in Barovia."); // story -> body
	assert.equal(frontmatter.description, "The opening chapter."); // description stays a field
	assert.ok(!("story" in frontmatter));
});

test("diffPayload sends only changed fields, leaving server-only fields alone (R7)", () => {
	const local = {
		name: "Ireena",
		description: "updated bio",
		traits: ["t-1", "t-2"],
		species: ["sp-1"],
	};
	const server = {
		name: "Ireena", // unchanged
		description: "old bio", // changed
		traits: ["t-2", "t-1"], // same set, different order -> unchanged
		species: ["sp-1"], // unchanged
		atlas_richtext_json: { doc: "..." }, // server-only -> must NOT appear in diff
	};
	const diff = diffPayload(local, server);
	assert.deepEqual(Object.keys(diff), ["description"]);
	assert.equal(diff.description, "updated bio");
});

test("diffPayload treats null and missing as equal", () => {
	const diff = diffPayload({ location: null, x: 5 }, { x: 5 });
	assert.deepEqual(diff, {}); // location null == server missing; x unchanged
});

// --- S9 readability bout: wikilink display + lean layout (R1/R3/R4) ----------

test("wikilinkTarget extracts the name from [[Name]] and [[Name|Alias]], else null", () => {
	assert.equal(wikilinkTarget("[[Ireena]]"), "Ireena");
	assert.equal(wikilinkTarget("[[Village of Barovia]]"), "Village of Barovia");
	assert.equal(wikilinkTarget("[[Ireena|the woman]]"), "Ireena"); // identity is pre-pipe
	assert.equal(wikilinkTarget("  [[Ireena]]  "), "Ireena"); // outer ws tolerated
	assert.equal(wikilinkTarget("018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b"), null); // bare id
	assert.equal(wikilinkTarget("not a link"), null);
	assert.equal(wikilinkTarget(null), null);
	assert.equal(wikilinkTarget(42), null);
});

test("isEmptyFieldValue: null/''/[]  are empty; 0/false/nonempty are not (R3)", () => {
	assert.ok(isEmptyFieldValue(null));
	assert.ok(isEmptyFieldValue(undefined));
	assert.ok(isEmptyFieldValue(""));
	assert.ok(isEmptyFieldValue("   "));
	assert.ok(isEmptyFieldValue([]));
	assert.ok(!isEmptyFieldValue(0)); // a real number
	assert.ok(!isEmptyFieldValue(false)); // a real boolean
	assert.ok(!isEmptyFieldValue("x"));
	assert.ok(!isEmptyFieldValue(["a"]));
});

test("R1 WRITE: link ids become [[Name]] with an id->name resolver, single + multi", () => {
	const idName: Record<string, string> = {
		"loc-1": "Village of Barovia",
		"sp-1": "Human",
		"tr-1": "Brave",
		"tr-2": "Kind",
	};
	const data = {
		id: "c-1",
		name: "Ireena",
		location: "loc-1", // single_link
		species: ["sp-1"], // multi_link
		traits: ["tr-1", "tr-2"], // multi_link
	};
	const fm = apiDataToFrontmatter(data, "character", "c-1", {
		resolveIdToName: (id) => idName[id] ?? null,
	});
	assert.equal(fm.location, "[[Village of Barovia]]");
	assert.deepEqual(fm.species, ["[[Human]]"]);
	assert.deepEqual(fm.traits, ["[[Brave]]", "[[Kind]]"]);
});

test("R1 WRITE: an id with no local note stays a raw id (dangling never lost)", () => {
	const data = { id: "c-1", name: "X", location: "loc-unknown", friends: ["c-9", "c-known"] };
	const fm = apiDataToFrontmatter(data, "character", "c-1", {
		resolveIdToName: (id) => (id === "c-known" ? "Known Friend" : null),
	});
	assert.equal(fm.location, "loc-unknown"); // unresolved single -> raw id
	assert.deepEqual(fm.friends, ["c-9", "[[Known Friend]]"]); // per-item fallback
});

test("R1 WRITE: no resolver -> raw ids (vault-less back-compat)", () => {
	const data = { id: "c-1", name: "X", location: "loc-1", species: ["sp-1"] };
	const fm = apiDataToFrontmatter(data, "character", "c-1");
	assert.equal(fm.location, "loc-1");
	assert.deepEqual(fm.species, ["sp-1"]);
});

test("R3 WRITE: null/''/[]  fields are omitted; id/name/extension-empty retained", () => {
	const data = {
		id: "c-1",
		name: "Ireena",
		location: null, // omit
		species: [], // omit
		image_url: "", // omit
		supertype: "NPC", // keep
		x_pinned: "", // extension empty -> KEEP (R3 exception)
		atlas_flag: "", // extension empty -> KEEP
	};
	const fm = apiDataToFrontmatter(data, "character", "c-1");
	assert.ok(!("location" in fm));
	assert.ok(!("species" in fm));
	assert.ok(!("image_url" in fm));
	assert.equal(fm.supertype, "NPC");
	assert.equal(fm.name, "Ireena"); // always present
	assert.equal(fm.id, "c-1"); // always present
	assert.equal(fm.x_pinned, ""); // extension kept even when empty
	assert.equal(fm.atlas_flag, "");
});

test("R4 WRITE: key order is name first, image_url then id LAST", () => {
	const data = {
		id: "c-1",
		name: "Ireena",
		supertype: "NPC",
		image_url: "http://img/x.png",
		location: "loc-1",
	};
	const fm = apiDataToFrontmatter(data, "character", "c-1");
	const keys = Object.keys(fm);
	assert.equal(keys[0], "name"); // name leads
	assert.equal(keys[keys.length - 1], "id"); // id last
	assert.equal(keys[keys.length - 2], "image_url"); // image_url just above id
	// content fields sit between name and image_url
	assert.ok(keys.indexOf("supertype") > 0 && keys.indexOf("supertype") < keys.indexOf("image_url"));
});

test("R1 READ: [[Name]] resolves to id via injected name->id resolver, single + multi", () => {
	const nameId: Record<string, string> = {
		"Village of Barovia": "loc-1",
		Human: "sp-1",
		Brave: "tr-1",
	};
	const fm = {
		id: "c-1",
		name: "Ireena",
		location: "[[Village of Barovia]]",
		species: ["[[Human]]"],
		traits: ["[[Brave]]"],
	};
	const out = frontmatterToPayloadFields(fm, "character", {
		resolveNameToId: (n) => nameId[n] ?? null,
	});
	assert.equal(out.location, "loc-1");
	assert.deepEqual(out.species, ["sp-1"]);
	assert.deepEqual(out.traits, ["tr-1"]);
});

test("R1 READ: [[Name|Alias]] resolves on Name; a bare uuid passes through", () => {
	const fm = {
		id: "c-1",
		name: "X",
		location: "[[Ireena|the woman]]",
		friends: ["018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b"], // already an id
	};
	const out = frontmatterToPayloadFields(fm, "character", {
		resolveNameToId: (n) => (n === "Ireena" ? "c-ireena" : null),
	});
	assert.equal(out.location, "c-ireena");
	assert.deepEqual(out.friends, ["018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b"]);
});

test("R1 READ: unresolvable [[Name]] is reported and dropped, never guessed", () => {
	const unresolved: string[] = [];
	const fm = {
		id: "c-1",
		name: "X",
		location: "[[Ghost Town]]", // single, unresolvable -> null
		friends: ["[[Nobody]]", "[[Real]]"], // multi, one drops
	};
	const out = frontmatterToPayloadFields(fm, "character", {
		resolveNameToId: (n) => (n === "Real" ? "c-real" : null),
		unresolved,
	});
	assert.equal(out.location, null); // unresolved single collapses to null
	assert.deepEqual(out.friends, ["c-real"]); // Nobody dropped
	assert.deepEqual(unresolved.sort(), ["Ghost Town", "Nobody"].sort());
});

test("R1 ROUND-TRIP: {id links} -> write(resolver) -> read(resolver) -> same id set", () => {
	const idName: Record<string, string> = {
		"loc-1": "Village of Barovia",
		"sp-1": "Human",
		"tr-1": "Brave",
		"tr-2": "Kind",
	};
	const nameId: Record<string, string> = Object.fromEntries(
		Object.entries(idName).map(([id, name]) => [name, id])
	);
	const original = {
		id: "c-1",
		name: "Ireena",
		location: "loc-1",
		species: ["sp-1"],
		traits: ["tr-1", "tr-2"],
	};
	// write: ids -> [[Name]]
	const fm = apiDataToFrontmatter(original, "character", "c-1", {
		resolveIdToName: (id) => idName[id] ?? null,
	});
	// read: [[Name]] -> ids
	const back = frontmatterToPayloadFields(fm, "character", {
		resolveNameToId: (n) => nameId[n] ?? null,
	});
	assert.equal(back.location, "loc-1");
	assert.deepEqual(back.species, ["sp-1"]);
	assert.deepEqual([...(back.traits as string[])].sort(), ["tr-1", "tr-2"]);
});

test("R1 ROUND-TRIP: a raw id that resolves to a note drifts to [[Name]] but recovers the id", () => {
	// A note carrying a raw id (unmigrated link). On write with a resolver it
	// becomes [[Name]]; on read it recovers the same id.
	const write = apiDataToFrontmatter(
		{ id: "c-1", name: "X", location: "loc-1" },
		"character",
		"c-1",
		{ resolveIdToName: (id) => (id === "loc-1" ? "Home" : null) }
	);
	assert.equal(write.location, "[[Home]]");
	const read = frontmatterToPayloadFields(write, "character", {
		resolveNameToId: (n) => (n === "Home" ? "loc-1" : null),
	});
	assert.equal(read.location, "loc-1");
});

test("extension fields never become wikilinks and never get empty-omitted (R1/R3 law)", () => {
	const fm = apiDataToFrontmatter(
		{ id: "c-1", name: "X", atlas_ref: "loc-1", x_empty: "", shadow_list: [] },
		"character",
		"c-1",
		{ resolveIdToName: () => "SHOULD NOT BE USED" }
	);
	assert.equal(fm.atlas_ref, "loc-1"); // NOT a [[wikilink]] — foreign, verbatim
	assert.equal(fm.x_empty, ""); // empty extension kept
	assert.deepEqual(fm.shadow_list, []); // empty extension array kept
});

test("idempotency: a note already in frontmatter is NOT span format", () => {
	const fmNote = `---
id: 018f-1
name: Ireena
species: sp-human
traits:
  - tr-brave
  - tr-kind
atlas_flag: keep
---

A young woman of Barovia.
`;
	assert.equal(isSpanFormat(fmNote), false);
	// payload extraction from its parsed frontmatter keeps the extension key
	const out = frontmatterToPayloadFields(
		{ id: "018f-1", name: "Ireena", species: ["sp-human"], traits: ["tr-brave", "tr-kind"], atlas_flag: "keep" },
		"character"
	);
	assert.equal(out.atlas_flag, "keep");
	assert.deepEqual(out.species, ["sp-human"]);
});
