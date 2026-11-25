/**
 * A note that loses its last own property: Save clears the world's group (the Markdown profile, sentence 4),
 * through the real SaveElementCommand and an in-memory vault and server. The clearing rides only on a note whose
 * change_seq is known AND that is marked as holding the world's group (a Download of an element with a group, or a save
 * or an upload that sent one), so a group the note never showed is never removed by a note that has none.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";
import { API_DROPPED_FIELDS, apiDataToFrontmatter, frontmatterToPayloadFields, getCategorySchema, holdsGroup, joinNote, serializeFrontmatter, withGroupCleared } from "../vault/element-transform";
import { heldKey } from "../vault/change-seq-index";

const ID = "0199c000-0000-7000-8000-0000000000b1";

const note = (fm: string) => `---\nname: Ireena\nid: ${ID}\n${fm}---\n\n### Description\n\nA noble.\n`;
const index = (o: Record<string, number>) => ({ "~/.ow-seq.json": JSON.stringify(o) });
const MARKED = index({ [ID]: 5, [heldKey(ID)]: 5 });
const held = (group: unknown, seq = 5) => ({ [ID]: { name: "Ireena", description: "A noble.", change_seq: seq, x_properties: group } });
const SEQ_FILE = "OnlyWorlds/Worlds/W/.ow-seq.json";
const seqOf = (r: { vault: { dotfiles: Map<string, string> } }): Record<string, number> => JSON.parse(r.vault.dotfiles.get(SEQ_FILE) ?? "{}");

test("★ the last own property deleted in a marked note whose number is current: the save clears the group and takes the mark away", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...MARKED },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(r.sent[0].x_properties, null);
	assert.equal(heldKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)));
});

test("★ a note with a number and no mark (made before the mark, or never shown the group) never clears: nothing is sent", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...index({ [ID]: 5 }) },
		save: "Character/Ireena.md",
		server: held({ name: "kept" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /already up to date/.test(n)), r.notices.join(" | "));
	assert.equal(heldKey(ID) in seqOf(r), false);
});

test("a note that keeps an entry of the group (its own x_properties) sends the group with it, never null, and stays marked", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("x_properties:\n  kept: 1\n"), ...MARKED },
		save: "Character/Ireena.md",
		server: held({ status: "draft", kept: 1 }),
		answer: { [ID]: { id: ID, change_seq: 6, x_properties: { kept: 1 } } },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.deepEqual(r.sent[0].x_properties, { kept: 1 });
	assert.equal(seqOf(r)[heldKey(ID)], 6, "the mark follows the number the save recorded");
});

test("a save that sends a group marks the note as holding it", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("status: done\n"), ...index({ [ID]: 5 }) },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
		answer: { [ID]: { id: ID, change_seq: 6, x_properties: { status: "done" } } },
	});
	assert.deepEqual(r.sent[0]?.x_properties, { status: "done" }, r.notices.join(" | "));
	assert.equal(seqOf(r)[ID], 6);
	assert.equal(seqOf(r)[heldKey(ID)], 6);
});

test("an unchanged save of a note that shows no group beside a world group records the number and no mark", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("") },
		save: "Character/Ireena.md",
		server: held({ name: "kept" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.equal(seqOf(r)[ID], 5);
	assert.equal(heldKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)));
});

test("★ a mark that is not the note's number (an older plugin renewed the number) clears nothing", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...index({ [ID]: 5, [heldKey(ID)]: 4 }) },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
});

test("an own property named like an Object member is saved, not refused as a duplicate of an empty group", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("constructor: 1\ntoString: 2\n"), ...index({ [ID]: 5 }) },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.deepEqual(r.sent[0].x_properties, { constructor: 1, toString: 2 });
});

test("a note with no number known never clears a group, marked or not", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...index({ [heldKey(ID)]: 1 }) },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
});

test("an element that moved since the note was pulled is refused as stale, the group untouched", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...MARKED },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }, 6),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /changed on onlyworlds.com since this note was pulled/.test(n)), r.notices.join(" | "));
});

test("a note and an element with no group at all: nothing is sent", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...MARKED },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /already up to date/.test(n)), r.notices.join(" | "));
});

test("Upload marks a note whose payload carries a group, and not one that carries none", async () => {
	const { harnessUpload } = await import("./support/upload-harness");
	const OTHER = "0199c000-0000-7000-8000-0000000000b2";
	const loc = (id: string, extra: string) => `---\nname: ${id === ID ? "Akragas" : "Gela"}\nid: ${id}\n${extra}---\n\n### Description\n\nA city.\n`;
	const up = (id: string) => ({ op: "upsert", type: "location", id, change_seq: 4, element: { id, name: "x" } });
	const r = await harnessUpload({
		notes: { "Location/Akragas.md": loc(ID, "status: done\n"), "Location/Gela.md": loc(OTHER, "") },
		changes: [up(ID), up(OTHER)],
		answerSeq: () => 9,
	});
	assert.equal(r.seqIndex[heldKey(ID)], 9, JSON.stringify(r.seqIndex));
	assert.equal(heldKey(OTHER) in r.seqIndex, false, JSON.stringify(r.seqIndex));
});

test("withGroupCleared adds the clearing only when guarded and only when the payload holds no group; holdsGroup needs an entry", () => {
	assert.deepEqual(withGroupCleared({ name: "A" }, true), { name: "A", x_properties: null });
	assert.deepEqual(withGroupCleared({ name: "A" }, false), { name: "A" });
	assert.deepEqual(withGroupCleared({ name: "A", x_properties: { k: 1 } }, true), { name: "A", x_properties: { k: 1 } });
	assert.equal(holdsGroup({ x_properties: { k: 1 } }), true);
	assert.equal(holdsGroup({ x_properties: {} }), false);
	assert.equal(holdsGroup({ x_properties: null }), false);
	assert.equal(holdsGroup({ name: "A" }), false);
});

test("the pull of an element whose group the world has cleared writes no x_properties line", () => {
	const fm = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: null }, "character", ID);
	assert.equal("x_properties" in fm, false, JSON.stringify(fm));
	const empty = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: {} }, "character", ID);
	assert.equal("x_properties" in empty, false, JSON.stringify(empty));
});

test("a type entry in the world's group that repeats the note's own type stays in the group, so a save sends it back", () => {
	const fm = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: { type: "Character", mood: "tense" } }, "character", ID);
	assert.deepEqual(fm.x_properties, { type: "Character" });
	assert.equal(fm.mood, "tense");
	assert.equal("type" in fm, false, JSON.stringify(fm));
});

// The mark lets a note with no group clear the world's, so every group a pull writes must come back out of the note as the same group:
// a pull then a save of an untouched note sends nothing. One group per entry, so a failure names the entry.
const ENTRIES: Record<string, unknown> = {
	status: "draft",
	mood: "tense",
	type: "Character",
	typeOther: "location",
	tags: ["server-tag"],
	aliases: ["an alias"],
	position: { x: 1, y: 2 },
	x_extra: "v",
	atlas_view: 3,
	"two words": "v",
	"0x10": 5,
	height: "tall",
	description: "from the group",
	created_at: "2020-01-01T00:00:00Z",
	name: "from the group",
	id: "from the group",
	nested: { a: { b: [1, 2] } },
	empty: "",
	zero: 0,
	flag: false,
	nothing: null,
	list: [],
};

for (const [key, value] of Object.entries(ENTRIES)) {
	test(`a pull then a save of an untouched note sends nothing: the group entry ${key}`, async () => {
		const name = key === "typeOther" ? "type" : key;
		const group = { [name]: value };
		const fm = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: group }, "character", ID);
		const text = joinNote(serializeFrontmatter(fm), "### Description\n\nA noble.\n");
		const r = await harnessSave({
			notes: { "Character/Ireena.md": text, ...MARKED },
			save: "Character/Ireena.md",
			server: held(group),
		});
		assert.equal(r.sent.length, 0, `${JSON.stringify(r.sent)} :: ${r.notices.join(" | ")} :: ${text}`);
	});
}

// Every category, every field name of it and the names a reader leaves out: the group a pull writes comes back out of a note as the same group.
const CATEGORIES = ["character", "creature", "species", "family", "collective", "institution", "location", "object", "construct", "ability", "trait", "title", "language", "law", "event", "narrative", "phenomenon", "relation", "map", "pin", "marker", "zone"];
const GENERIC = ["relations", "type", "tags", "aliases", "position", "description", "story", "name", "id", "world", "world_id", "element_type", "element_id", "image_url", "status", "x_a", "atlas_b", "created_at", "change_seq", "supertype", "subtype"];

test("★ every category: a group entry named like a field, a server key or a dropped name comes back out of the note as the same group", () => {
	const bad: string[] = [];
	for (const category of CATEGORIES) {
		const schema = getCategorySchema(category) ?? {};
		const names = new Set([...Object.keys(schema), ...GENERIC, ...(API_DROPPED_FIELDS[category] ?? [])]);
		for (const name of names) {
			const group = { [name]: name === "type" ? "Character" : "v" };
			const fm = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: group }, category, ID);
			const out = frontmatterToPayloadFields(fm, category).x_properties;
			if (JSON.stringify(out) !== JSON.stringify(group)) bad.push(`${category}.${name} -> ${JSON.stringify(out)}`);
		}
	}
	assert.deepEqual(bad, []);
});
