/**
 * A world's Bases file: the text the plugin writes as
 * `<world>.base` beside World.md, so each element type gets a table and a card
 * view in Obsidian's core Bases. Pure: vault/bases-file.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// js-yaml and yaml are in node_modules through the eslint toolchain (as in
// test/support/obsidian-mock.ts): the text must parse under both.
// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
const jsYaml = require("js-yaml") as { load(s: string): unknown };
// eslint-disable-next-line import/no-extraneous-dependencies
import { parse as yaml2Parse } from "yaml";
import { buildBasesFile, mayOverwriteBasesFile, MAX_TYPE_COLUMNS, type BasesSchema } from "../vault/bases-file";

/** A small schema: Character has an image field, Law has none. */
const SCHEMA: BasesSchema = {
	Character: {
		name: { type: "text" },
		description: { type: "text" },
		supertype: { type: "text" },
		subtype: { type: "text" },
		image_url: { type: "text" },
		physicality: { type: "text" },
		height: { type: "integer" },
		species: { type: "multi_link" },
		birth_date: { type: "integer" },
		birthplace: { type: "single_link" },
	},
	Law: {
		name: { type: "text" },
		description: { type: "text" },
		supertype: { type: "text" },
		subtype: { type: "text" },
		declaration: { type: "text" },
		author: { type: "single_link" },
	},
};

const HYPERION = { worldName: "Hyperion", worldFolderPath: "OnlyWorlds/Worlds/Hyperion", schema: SCHEMA };

const EXPECTED_BODY = `# World: Hyperion
filters:
  and:
    - 'file.inFolder("OnlyWorlds/Worlds/Hyperion/Elements")'
    - 'file.ext == "md"'
formulas:
  element_type: 'file.folder.split("/")[4].split(" (")[0]'
properties:
  file.name:
    displayName: "Name"
  formula.element_type:
    displayName: "Type"
  supertype:
    displayName: "Supertype"
  subtype:
    displayName: "Subtype"
  height:
    displayName: "Height"
  species:
    displayName: "Species"
  birth_date:
    displayName: "Birth Date"
  birthplace:
    displayName: "Birthplace"
  author:
    displayName: "Author"
views:
  - type: table
    name: "All elements"
    order:
      - file.name
      - formula.element_type
      - note.supertype
      - note.subtype
  - type: table
    name: "Characters"
    filters:
      or:
        - 'file.inFolder("OnlyWorlds/Worlds/Hyperion/Elements/Character")'
        - 'file.folder.startsWith("OnlyWorlds/Worlds/Hyperion/Elements/Character (")'
    order:
      - file.name
      - note.supertype
      - note.subtype
      - note.height
      - note.species
      - note.birth_date
      - note.birthplace
  - type: cards
    name: "Characters (cards)"
    filters:
      or:
        - 'file.inFolder("OnlyWorlds/Worlds/Hyperion/Elements/Character")'
        - 'file.folder.startsWith("OnlyWorlds/Worlds/Hyperion/Elements/Character (")'
    order:
      - file.name
      - note.supertype
      - note.subtype
    image: note.image_url
  - type: table
    name: "Laws"
    filters:
      or:
        - 'file.inFolder("OnlyWorlds/Worlds/Hyperion/Elements/Law")'
        - 'file.folder.startsWith("OnlyWorlds/Worlds/Hyperion/Elements/Law (")'
    order:
      - file.name
      - note.supertype
      - note.subtype
      - note.author
  - type: cards
    name: "Laws (cards)"
    filters:
      or:
        - 'file.inFolder("OnlyWorlds/Worlds/Hyperion/Elements/Law")'
        - 'file.folder.startsWith("OnlyWorlds/Worlds/Hyperion/Elements/Law (")'
    order:
      - file.name
      - note.supertype
      - note.subtype
`;

function body(text: string): string {
	return text.split("\n").slice(1).join("\n");
}

test("the Bases file for a small schema: world filter, a type formula, an All elements table, then a table and a cards view per type", () => {
	const text = buildBasesFile(HYPERION);
	assert.match(text.split("\n")[0], /^# OnlyWorlds Builder wrote this file\. .*owb-bases:1:[0-9a-f]{8}$/);
	assert.equal(body(text), EXPECTED_BODY);
});

test("the Bases file is valid YAML under both parsers, with the shape Bases reads", () => {
	const text = buildBasesFile(HYPERION);
	for (const parse of [jsYaml.load, yaml2Parse] as Array<(s: string) => unknown>) {
		const doc = parse(text) as {
			filters: { and: string[] };
			formulas: Record<string, string>;
			views: Array<{ type: string; name: string; order: string[]; image?: string; filters?: { or: string[] } }>;
		};
		assert.deepEqual(doc.filters.and, ['file.inFolder("OnlyWorlds/Worlds/Hyperion/Elements")', 'file.ext == "md"']);
		assert.deepEqual(
			doc.views.map((v) => `${v.type}:${v.name}`),
			["table:All elements", "table:Characters", "cards:Characters (cards)", "table:Laws", "cards:Laws (cards)"]
		);
		assert.equal(doc.views[2].image, "note.image_url");
	}
});

test("a type with no image field gets a cards view with no image key", () => {
	const text = buildBasesFile(HYPERION);
	const doc = jsYaml.load(text) as { views: Array<{ name: string; image?: string }> };
	const lawCards = doc.views.find((v) => v.name === "Laws (cards)");
	assert.ok(lawCards);
	assert.equal("image" in lawCards, false);
});

test(`a type's columns stop at ${MAX_TYPE_COLUMNS} of its fields, in schema order; text fields (the note body) are never columns`, () => {
	const wide: Record<string, { type: string }> = { name: { type: "text" }, supertype: { type: "text" }, subtype: { type: "text" } };
	for (let i = 1; i <= 12; i++) wide[`stat_${i}`] = { type: i % 3 === 0 ? "text" : "integer" };
	const text = buildBasesFile({ ...HYPERION, schema: { Creature: wide } });
	const doc = jsYaml.load(text) as { views: Array<{ name: string; order: string[] }> };
	const table = doc.views.find((v) => v.name === "Creatures");
	assert.ok(table);
	assert.deepEqual(table.order, [
		"file.name",
		"note.supertype",
		"note.subtype",
		...["stat_1", "stat_2", "stat_4", "stat_5", "stat_7", "stat_8", "stat_10", "stat_11"].map((k) => `note.${k}`),
	]);
});

test("view names are the plain plurals: Abilities, Families, Phenomena, Species", () => {
	const one = { name: { type: "text" } };
	const text = buildBasesFile({ ...HYPERION, schema: { Ability: one, Family: one, Phenomenon: one, Species: one, Object: one } });
	const doc = jsYaml.load(text) as { views: Array<{ type: string; name: string }> };
	assert.deepEqual(
		doc.views.filter((v) => v.type === "table").map((v) => v.name),
		["All elements", "Abilities", "Families", "Phenomena", "Species", "Objects"]
	);
});

test("a world folder with an apostrophe still yields valid YAML and the exact path", () => {
	const text = buildBasesFile({ worldName: "Tess's World", worldFolderPath: "OnlyWorlds/Worlds/Tess's World", schema: SCHEMA });
	for (const parse of [jsYaml.load, yaml2Parse] as Array<(s: string) => unknown>) {
		const doc = parse(text) as { filters: { and: string[] }; views: Array<{ name: string; filters?: { or: string[] } }> };
		assert.equal(doc.filters.and[0], `file.inFolder("OnlyWorlds/Worlds/Tess's World/Elements")`);
		assert.equal(doc.views[1].filters?.or[0], `file.inFolder("OnlyWorlds/Worlds/Tess's World/Elements/Character")`);
	}
});

test("the type formula indexes the category segment of the world's own depth", () => {
	const text = buildBasesFile({ ...HYPERION, worldFolderPath: "Deep/OnlyWorlds/Worlds/Hyperion" });
	assert.match(text, /element_type: 'file\.folder\.split\("\/"\)\[5\]\.split\(" \("\)\[0\]'/);
});

test("the plugin may overwrite only a file it wrote and nobody changed since", () => {
	const text = buildBasesFile(HYPERION);
	assert.equal(mayOverwriteBasesFile(text), true, "its own file");
	assert.equal(mayOverwriteBasesFile(text.replace(/\n/g, "\r\n")), true, "its own file, line endings changed by a sync tool");
	assert.equal(mayOverwriteBasesFile(text.replace('name: "Characters"', 'name: "People"')), false, "a view renamed by hand");
	assert.equal(mayOverwriteBasesFile(body(text)), false, "the marker line removed");
	assert.equal(mayOverwriteBasesFile("views:\n  - type: table\n    name: Mine\n"), false, "a user's own base");
	assert.equal(mayOverwriteBasesFile(""), false, "an empty file");
});
