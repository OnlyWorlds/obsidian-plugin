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
