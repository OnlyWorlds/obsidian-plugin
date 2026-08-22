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
	bodyTextFields,
	fieldToHeading,
	headingToFieldKey,
	buildElementBody,
	parseElementBody,
	bodyToFieldValues,
	splitNote,
	joinNote,
	serializeFrontmatter,
	isEmptyFieldValue,
	parseRawFrontmatterScalars,
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
		bogus_unknown: "keep me", // unknown non-extension key -> ADOPTED as x_bogus_unknown
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
	// An unknown bare key is no longer DROPPED — it is adopted under x_ so the
	// user's data survives the upload (the API rejects unknown bare keys).
	assert.ok(!("bogus_unknown" in out));
	assert.equal(out.x_bogus_unknown, "keep me");
});

test("adoption: an unknown bare key is namespaced, not dropped, and is reported", () => {
	const adopted: Array<{ from: string; to: string }> = [];
	const fm = { id: "c-1", name: "Ireena", mood: "wary", tally: 3 };
	const out = frontmatterToPayloadFields(fm, "character", { adopted });
	assert.equal(out.x_mood, "wary");
	assert.equal(out.x_tally, 3); // any JSON type rides verbatim
	assert.ok(!("mood" in out));
	assert.deepEqual(adopted, [
		{ from: "mood", to: "x_mood" },
		{ from: "tally", to: "x_tally" },
	]);
});

test("adoption: does not clobber an existing x_ key of the same name", () => {
	const adopted: Array<{ from: string; to: string }> = [];
	// Both `mood` and `x_mood` present: the already-namespaced one wins and the
	// bare one is skipped, so adoption can never overwrite real custom data.
	const fm = { id: "c-1", name: "Ireena", mood: "bare", x_mood: "namespaced" };
	const out = frontmatterToPayloadFields(fm, "character", { adopted });
	assert.equal(out.x_mood, "namespaced");
	assert.deepEqual(adopted, []);
});

test("adoption: schema fields and meta keys are never adopted", () => {
	const adopted: Array<{ from: string; to: string }> = [];
	const fm = {
		id: "c-1",
		name: "Ireena",
		physicality: "tall", // real schema field
		world: "w-1", // meta key
		description: "body", // body field
		aliases: ["I"], // obsidian meta
	};
	const out = frontmatterToPayloadFields(fm, "character", { adopted });
	assert.equal(out.physicality, "tall");
	assert.deepEqual(adopted, []);
	for (const k of ["x_id", "x_world", "x_description", "x_aliases", "x_name"]) {
		assert.ok(!(k in out), `${k} must not be adopted`);
	}
});

test("adoption: an already-namespaced key is untouched (no double prefix)", () => {
	const adopted: Array<{ from: string; to: string }> = [];
	const fm = { id: "c-1", name: "Ireena", x_mood: "wary", atlas_thing: 1 };
	const out = frontmatterToPayloadFields(fm, "character", { adopted });
	assert.equal(out.x_mood, "wary");
	assert.equal(out.atlas_thing, 1);
	assert.ok(!("x_x_mood" in out));
	assert.ok(!("x_atlas_thing" in out));
	assert.deepEqual(adopted, []);
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

test("v3.2 WRITE: key order is BASE, then numbers, then links (§2 ruling)", () => {
	// Supersedes the 3.0 "name first, id LAST" layout. Captain's 2026-08-22
	// ruling: base identity at the top where a reader scans, then compact number
	// scalars, then link lists (which grow) at the bottom. Obsidian renders
	// properties in key order, so this assembly IS the panel layout.
	const data = {
		id: "c-1",
		name: "Ireena",
		supertype: "NPC",
		subtype: "Ally",
		image_url: "http://img/x.png",
		location: "loc-1", // single_link
		traits: ["t-1"], // multi_link
		height: 165, // number
		charisma: 60, // number
		physicality: "Tall.", // TEXT -> body, must not appear
	};
	const fm = apiDataToFrontmatter(data, "character", "c-1");
	const keys = Object.keys(fm);
	assert.deepEqual(keys.slice(0, 5), ["name", "id", "supertype", "subtype", "image_url"]);
	// every number precedes every link
	const lastNum = Math.max(keys.indexOf("height"), keys.indexOf("charisma"));
	const firstLink = Math.min(keys.indexOf("location"), keys.indexOf("traits"));
	assert.ok(lastNum < firstLink, `numbers must precede links: ${keys.join(",")}`);
	// text fields are gone from frontmatter — they live in the body now
	assert.ok(!("physicality" in fm));
});

test("v3.2 WRITE: text fields are excluded from frontmatter, base text keys are not", () => {
	const fm = apiDataToFrontmatter(
		{ id: "c-1", name: "Ireena", supertype: "NPC", physicality: "Tall.", background: "Third son." },
		"character",
		"c-1"
	);
	assert.equal(fm.supertype, "NPC"); // base text key stays
	assert.ok(!("physicality" in fm));
	assert.ok(!("background" in fm));
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

// --- S9 download resolver: raw-frontmatter scalar parse (disk-scan fallback) --

test("parseRawFrontmatterScalars: reads id/name from a plain block, ignores body", () => {
	const note = `---
name: Ireena Kolyana
location: "[[Village of Barovia]]"
image_url: http://img/x.png
id: 018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b
---

A young woman of Barovia.
`;
	const out = parseRawFrontmatterScalars(note, ["id", "name"]);
	assert.equal(out.id, "018f4a1b-2c3d-7e4f-8a9b-0c1d2e3f4a5b");
	assert.equal(out.name, "Ireena Kolyana");
});

test("parseRawFrontmatterScalars: strips a single layer of matching quotes (YAML-special names)", () => {
	// Obsidian quotes a name containing ':' — the disk fallback must unquote it
	// so the [[Name]] target matches the sanitized basename.
	const note = `---
name: "Chapter 1: The Road"
id: 018f0000-0000-7000-8000-000000000001
---
body`;
	const out = parseRawFrontmatterScalars(note, ["id", "name"]);
	assert.equal(out.name, "Chapter 1: The Road");
	assert.equal(out.id, "018f0000-0000-7000-8000-000000000001");
});

test("parseRawFrontmatterScalars: no frontmatter / missing keys -> empty, never throws", () => {
	assert.deepEqual(parseRawFrontmatterScalars("no frontmatter here", ["id", "name"]), {});
	assert.deepEqual(parseRawFrontmatterScalars("", ["id", "name"]), {});
	const partial = parseRawFrontmatterScalars(`---\nname: Solo\n---\nx`, ["id", "name"]);
	assert.deepEqual(partial, { name: "Solo" }); // id absent -> omitted, no id key
});

test("parseRawFrontmatterScalars: an empty value is omitted (not stored as '')", () => {
	const out = parseRawFrontmatterScalars(`---\nname:\nid: x-1\n---\nb`, ["id", "name"]);
	assert.deepEqual(out, { id: "x-1" });
});

test("S9: apiDataToFrontmatter with a download-style id->name map renders links; unknown id stays raw", () => {
	// Mirrors DownloadWorldCommand's injected map: a complete id->basename map from
	// the payload. The bug was that ids resolved to null (cold cache) -> raw uuids.
	const map: Record<string, string> = {
		"loc-1": "Village of Barovia",
		"sp-1": "Human",
	};
	const data = {
		id: "c-1",
		name: "Admiral Fluffington",
		location: "loc-1", // single_link
		species: ["sp-1", "sp-missing"], // multi_link, one absent
		objects: ["obj-absent"], // multi_link, all absent
	};
	const fm = apiDataToFrontmatter(data, "character", "c-1", {
		resolveIdToName: (id) => map[id] ?? null,
	});
	assert.equal(fm.location, "[[Village of Barovia]]");
	assert.deepEqual(fm.species, ["[[Human]]", "sp-missing"]); // known -> link, absent -> raw
	assert.deepEqual(fm.objects, ["obj-absent"]); // never [[Unknown]], never dropped
});

test("S9 colon-name round-trip: a sanitized basename from the map wraps verbatim to a clickable [[link]]", () => {
	// DownloadWorldCommand's map returns sanitizeFileName(name), so a character
	// "Snoot: The Bold" (file "Snoot- The Bold.md") enters the resolver already
	// as "Snoot- The Bold". apiDataToFrontmatter must wrap it verbatim — the
	// [[target]] must equal the note's real basename or the link dangles.
	const sanitizedBasename = "Snoot- The Bold"; // what sanitizeFileName(":"->"-") yields
	const data = { id: "c-1", name: "Admiral Fluffington", friends: ["c-snoot"] };
	const fm = apiDataToFrontmatter(data, "character", "c-1", {
		resolveIdToName: (id) => (id === "c-snoot" ? sanitizedBasename : null),
	});
	assert.deepEqual(fm.friends, ["[[Snoot- The Bold]]"]); // clickable, matches the file
	// And the target parses back to the same basename (identity survives).
	assert.equal(wikilinkTarget((fm.friends as string[])[0]), sanitizedBasename);
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

// --- upload safety: omit-field-on-unresolved (audit finding, 2026-07-17) -----

test("frontmatterToPayloadFields: omitFieldOnUnresolved drops the whole field (multi)", () => {
	// A multi-link with one resolvable + one dangling [[Name]]. Without the omit,
	// the payload would carry a SHORTENED list, and a full-field PATCH would strip
	// the server's copy of the dropped link. With omit, the field is absent so the
	// server value wins.
	const fm = { id: "x", name: "N", traits: ["[[Brave]]", "[[Ghost]]"] };
	const resolve = (n: string) => (n === "Brave" ? "id-brave" : null);
	const unresolved: string[] = [];
	const out = frontmatterToPayloadFields(fm, "character", {
		resolveNameToId: resolve,
		unresolved,
		omitFieldOnUnresolved: true,
	});
	assert.equal("traits" in out, false, "field omitted, not shortened");
	assert.deepEqual(unresolved, ["Ghost"]);
});

test("frontmatterToPayloadFields: without omit, unresolved multi is shortened (download-context)", () => {
	const fm = { id: "x", name: "N", traits: ["[[Brave]]", "[[Ghost]]"] };
	const resolve = (n: string) => (n === "Brave" ? "id-brave" : null);
	const out = frontmatterToPayloadFields(fm, "character", { resolveNameToId: resolve });
	assert.deepEqual(out.traits, ["id-brave"]); // shortened, field present
});

test("frontmatterToPayloadFields: omit drops an unresolved single link's field", () => {
	const fm = { id: "x", name: "N", location: "[[Nowhere]]" };
	const out = frontmatterToPayloadFields(fm, "character", {
		resolveNameToId: () => null,
		omitFieldOnUnresolved: true,
	});
	assert.equal("location" in out, false);
});

test("frontmatterToPayloadFields: omit keeps a fully-resolvable field intact", () => {
	const fm = { id: "x", name: "N", traits: ["[[Brave]]", "[[Bold]]"] };
	const resolve = (n: string) => (n === "Brave" ? "id-1" : n === "Bold" ? "id-2" : null);
	const out = frontmatterToPayloadFields(fm, "character", {
		resolveNameToId: resolve,
		omitFieldOnUnresolved: true,
	});
	assert.deepEqual(out.traits, ["id-1", "id-2"]);
});

// --- body sections (v3.2 format) ---------------------------------------------

test("bodyTextFields: body field first, then text fields in schema order", () => {
	const f = bodyTextFields("character");
	assert.equal(f[0], "description");
	assert.deepEqual(f, ["description", "physicality", "mentality", "background", "motivations", "reputation"]);
	// Narrative's body field is story, not description
	assert.equal(bodyTextFields("narrative")[0], "story");
	// Marker has no text fields beyond the body field
	assert.deepEqual(bodyTextFields("marker"), ["description"]);
});

test("heading <-> field key round-trips, tolerating case and spacing", () => {
	assert.equal(fieldToHeading("political_climate"), "Political Climate");
	assert.equal(headingToFieldKey("Political Climate"), "political_climate");
	assert.equal(headingToFieldKey("  political   climate  "), "political_climate");
	assert.equal(headingToFieldKey("PHYSICALITY"), "physicality");
});

test("buildElementBody: every text field gets a section, empty ones included (the scaffold)", () => {
	const body = buildElementBody({ description: "A knight.", physicality: "Tall." }, "character");
	assert.match(body, /## Description\n\nA knight\./);
	assert.match(body, /## Physicality\n\nTall\./);
	// Empty fields still get their heading — this is what makes them discoverable
	assert.match(body, /## Mentality\n/);
	assert.match(body, /## Motivations\n/);
	for (const h of ["Description", "Physicality", "Mentality", "Background", "Motivations", "Reputation"]) {
		assert.ok(body.includes(`## ${h}`), `missing ## ${h}`);
	}
});

test("parseElementBody: sections map to their fields", () => {
	const body = "## Description\n\nA knight.\n\n## Physicality\n\nTall and weathered.\n";
	const p = parseElementBody(body, "character");
	assert.equal(p.fields.description, "A knight.");
	assert.equal(p.fields.physicality, "Tall and weathered.");
	assert.deepEqual(p.unknown, []);
	assert.equal(p.preamble, "");
});

test("★ never-drop: an unknown heading keeps its prose in the body field", () => {
	const body = "## Description\n\nA knight.\n\n## Backstory\n\nRenamed by the user.\n";
	const out = bodyToFieldValues(body, "character");
	assert.match(out.description, /A knight\./);
	// The renamed section is NOT lost — heading and prose both survive
	assert.match(out.description, /## Backstory/);
	assert.match(out.description, /Renamed by the user\./);
});

test("★ never-drop: preamble before the first heading survives", () => {
	const body = "Stray text someone typed at the top.\n\n## Description\n\nA knight.\n";
	const out = bodyToFieldValues(body, "character");
	assert.match(out.description, /Stray text someone typed at the top\./);
	assert.match(out.description, /A knight\./);
});

test("body sections: #### and deeper stay inside their section", () => {
	// `##` and `###` are BOTH boundaries (we write ###; earlier 3.2 builds wrote
	// ##), so a user's own sub-structure starts at ####.
	const body = "### Background\n\nBorn in Waterdeep.\n\n#### Childhood\n\nUneventful.\n";
	const p = parseElementBody(body, "character");
	assert.match(p.fields.background, /Born in Waterdeep\./);
	assert.match(p.fields.background, /#### Childhood/); // user sub-structure preserved
	assert.deepEqual(p.unknown, []);
});

test("body sections: ## and ### both read as boundaries (back-compat)", () => {
	const h2 = parseElementBody("## Description\n\nA knight.\n\n## Physicality\n\nTall.\n", "character");
	const h3 = parseElementBody("### Description\n\nA knight.\n\n### Physicality\n\nTall.\n", "character");
	assert.deepEqual(h2.fields, h3.fields);
	assert.equal(h3.fields.physicality, "Tall.");
});

test("buildElementBody writes ### and puts a blank line under every heading", () => {
	const body = buildElementBody({ description: "A knight." }, "character");
	assert.match(body, /^### Description\n\nA knight\./);
	assert.match(body, /### Mentality\n\n/); // empty sections get the gap too
});

test("body sections: a ## inside a fenced code block does not split a section", () => {
	const body = "## Description\n\n```md\n## Not A Heading\n```\n\nstill description\n";
	const p = parseElementBody(body, "character");
	assert.match(p.fields.description, /## Not A Heading/);
	assert.match(p.fields.description, /still description/);
	assert.deepEqual(p.unknown, []);
});

test("body round-trip: build -> parse returns the same values", () => {
	const values = {
		description: "A knight.",
		physicality: "Tall.",
		mentality: "Wary.",
		background: "Third son.",
		motivations: "Redemption.",
		reputation: "Feared.",
	};
	const parsed = parseElementBody(buildElementBody(values, "character"), "character");
	assert.deepEqual(parsed.fields, values);
	assert.deepEqual(parsed.unknown, []);
});

test("body round-trip: empty scaffold parses back to empty strings, not junk", () => {
	const parsed = parseElementBody(buildElementBody({}, "character"), "character");
	for (const k of ["description", "physicality", "mentality", "background", "motivations", "reputation"]) {
		assert.equal(parsed.fields[k], "", `${k} should be empty`);
	}
	assert.deepEqual(parsed.unknown, []);
});

test("narrative: the body field is story and gets a ## Story heading", () => {
	const body = buildElementBody({ story: "Once upon a time." }, "narrative");
	assert.match(body, /## Story\n\nOnce upon a time\./);
	const out = bodyToFieldValues(body, "narrative");
	assert.equal(out.story, "Once upon a time.");
});

test("custom text fields render without the x_ prefix and parse back to it", () => {
	const body = buildElementBody({ description: "A knight.", x_looks: "Weathered." }, "character", ["x_looks"]);
	assert.match(body, /## Looks\n\nWeathered\./);
	assert.ok(!body.includes("x_looks"));
	// Unknown to the schema, so it lands in unknown[] for the caller to re-key
	const p = parseElementBody(body, "character");
	assert.equal(p.unknown.length, 1);
	assert.equal(p.unknown[0].heading, "Looks");
	assert.equal(p.unknown[0].text, "Weathered.");
});

test("scaffold: a new element carries its whole field set, ordered base/numbers/links", () => {
	const fm = apiDataToFrontmatter({ name: "New Character" }, "character", "c-1", {
		scaffoldEmptyFields: true,
	});
	const keys = Object.keys(fm);
	assert.deepEqual(keys.slice(0, 5), ["name", "id", "supertype", "subtype", "image_url"]);
	// numbers seeded null, multi-links seeded [], single-links seeded ""
	assert.equal(fm.charisma, null);
	assert.deepEqual(fm.species, []);
	assert.equal(fm.location, "");
	// text fields never appear in frontmatter, even in scaffold mode
	for (const k of ["physicality", "mentality", "background", "motivations", "reputation"]) {
		assert.ok(!(k in fm), `${k} belongs in the body`);
	}
	const lastNum = keys.indexOf("CHA");
	const firstLink = keys.indexOf("species");
	assert.ok(lastNum < firstLink, "numbers must precede links");
});

test("scaffold: off by default, so downloads still show only what has values", () => {
	const fm = apiDataToFrontmatter({ name: "Ireena", charisma: 60 }, "character", "c-1");
	assert.equal(fm.charisma, 60);
	assert.ok(!("STR" in fm)); // empty fields omitted on a normal write
});

test("scaffold: a real value always beats the empty seed", () => {
	const fm = apiDataToFrontmatter({ name: "Ireena", charisma: 60, species: ["sp-1"] }, "character", "c-1", {
		scaffoldEmptyFields: true,
	});
	assert.equal(fm.charisma, 60);
	assert.deepEqual(fm.species, ["sp-1"]);
});

test("custom body sections round-trip as x_ fields when known", () => {
	const body = "## Description\n\nA knight.\n\n## Looks\n\nWeathered.\n";
	const out = bodyToFieldValues(body, "character", ["x_looks"]);
	assert.equal(out.x_looks, "Weathered.");
	assert.equal(out.description, "A knight."); // not salvaged into description
});

test("custom body sections: unknown-and-untracked still salvages (never-drop holds)", () => {
	const body = "## Description\n\nA knight.\n\n## Looks\n\nWeathered.\n";
	const out = bodyToFieldValues(body, "character"); // no known custom keys
	assert.match(out.description, /## Looks/);
	assert.match(out.description, /Weathered\./);
});

// --- frontmatter position (the 2026-08-22 corruption) -------------------------

test("★ splitNote finds frontmatter even when blank lines precede it", () => {
	const good = "---\nname: x\nid: 1\n---\n\n## Description\n\nhi\n";
	const bad = "\n\n\n" + good;
	// The naive startsWith('---') check reported "no frontmatter" here, so the
	// next rewrite pushed the YAML into the body and the damage compounded.
	assert.equal(splitNote(bad).frontmatter, "---\nname: x\nid: 1\n---");
	assert.match(splitNote(bad).body, /^## Description/);
	assert.equal(splitNote(good).frontmatter, splitNote(bad).frontmatter);
});

test("★ joinNote always puts frontmatter at byte 0 — repairs a damaged note", () => {
	const damaged = "\n\n\n---\nname: x\nid: 1\n---\n\n## Description\n\nhi\n";
	const { frontmatter, body } = splitNote(damaged);
	const repaired = joinNote(frontmatter, body);
	assert.ok(repaired.startsWith("---"), "must start at byte 0");
	assert.ok(!/^\s*\n/.test(repaired));
	// and it is idempotent
	const twice = joinNote(...Object.values(splitNote(repaired)) as [string, string]);
	assert.equal(twice, repaired);
});

test("joinNote: no frontmatter yields the body unchanged (no stray separator)", () => {
	assert.equal(joinNote("", "## Description\n\nhi\n"), "## Description\n\nhi\n");
});

test("splitNote: a note with no frontmatter is all body", () => {
	const s = splitNote("just prose\n");
	assert.equal(s.frontmatter, "");
	assert.equal(s.body, "just prose\n");
});

test("serializeFrontmatter emits a block that starts at byte 0 and round-trips", () => {
	const fm = {
		name: "Ireena",
		id: "c-1",
		supertype: "",
		height: 165,
		charisma: null,
		species: [] as string[],
		traits: ["[[Brave]]", "[[Kind]]"],
		x_obj: { a: 1 },
	};
	const block = serializeFrontmatter(fm);
	assert.ok(block.startsWith("---\n"));
	assert.ok(block.endsWith("\n---"));
	assert.match(block, /^name: Ireena$/m);
	assert.match(block, /^charisma:$/m); // null -> bare key
	assert.match(block, /^species: \[\]$/m);
	assert.match(block, /^ {2}- "\[\[Brave\]\]"$/m); // [[ ]] must be quoted
	assert.match(block, /^x_obj: \{"a":1\}$/m);
	// and the assembled note always begins with the block
	assert.ok(joinNote(block, "### Description\n\n").startsWith("---\nname:"));
});

test("★ a full write cycle can never emit leading blank lines", () => {
	// The corruption was: block not at byte 0 -> Obsidian stops seeing frontmatter.
	const block = serializeFrontmatter({ name: "x", id: "1" });
	for (const body of ["", "\n", "\n\n\n### Description\n", "### Description\n\nhi\n"]) {
		const out = joinNote(block, body);
		assert.ok(out.startsWith("---"), `body ${JSON.stringify(body)} produced ${JSON.stringify(out.slice(0, 8))}`);
	}
});
