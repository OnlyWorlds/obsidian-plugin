/**
 * A save leaves the note's mark (vault/note-mark-core.ts) only where the world holds the note's bytes: the pull's own render of
 * the element the world answered with, made over the note as it stands, equals the note byte for byte. What a send carries can
 * leave out a value the note holds, and a mark made from the sent bytes lets the next pull write over that text with no copy.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";
import { getCategorySchema } from "../vault/element-transform";
import { groupMarkKey, markKey, noteMark, valueMark } from "../vault/note-mark-core";

const ID = "0199c000-0000-7000-8000-0000000000b2";
const WATERDEEP = "0199c000-0000-7000-8000-0000000000c1";
const BAROVIA = "0199c000-0000-7000-8000-0000000000c2";
const SEQ_FILE = "OnlyWorlds/Worlds/W/.ow-seq.json";
const seqOf = (r: { vault: { dotfiles: Map<string, string> } }): Record<string, number> => JSON.parse(r.vault.dotfiles.get(SEQ_FILE) ?? "{}");
const bytesOf = (r: { vault: { files: Map<string, { content: string }> } }) => [...r.vault.files.entries()].find(([p]) => p.endsWith("Character/Ireena.md"))?.[1].content ?? "";
const EMPTY = "\n### Physicality\n\n\n### Mentality\n\n\n### Background\n\n\n### Motivations\n\n\n### Reputation\n\n\n";
/** A Character note as a pull writes it: the numbers and links the note holds, the sections, the empty ones last. */
const pulled = (o: { fm?: string; description?: string; sections?: string; seq?: number } = {}) =>
	`---\nname: Ireena\nid: ${ID}\n${o.fm ?? ""}change_seq: ${o.seq ?? 5}\n---\n\n### Description\n\n${o.description ?? "A noble."}\n${o.sections ? `\n${o.sections}` : ""}${EMPTY}`;
const places = {
	"Location/Waterdeep.md": `---\nname: Waterdeep\nid: ${WATERDEEP}\n---\n\n### Description\n\nA city.\n`,
	"Location/Barovia.md": `---\nname: Barovia\nid: ${BAROVIA}\n---\n\n### Description\n\nA valley.\n`,
};
const OLD = { [ID]: 5, [markKey(ID)]: 1 };
/** An element as keel answers it: every field of its type, the unset ones null, then what this answer sets. */
const whole = (over: Record<string, unknown>): Record<string, unknown> => ({
	...Object.fromEntries(Object.keys(getCategorySchema("character") ?? {}).map((k) => [k, null])),
	id: ID,
	name: "Ireena",
	...over,
});


test("★ a save that sends the edit marks a note the world now holds, at the bytes it holds", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble, edited.", change_seq: 6 }) },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), "the mark is not the saved note's: " + JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("a save that finds the note equal to the world marks it too", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify({ [ID]: 5 }) },
		save: "Character/Ireena.md",
		server: { [ID]: whole({ description: "A noble, edited.", physicality: "", mentality: "", background: "", motivations: "", reputation: "", change_seq: 5 }) },
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)));
});

test("a note made by Create, its empty fields shown, is marked once the world holds it", async () => {
	const scaffold = `---\nname: Ireena\nid: ${ID}\nsupertype: ""\nsubtype: ""\nimage_url: ""\nheight:\nweight:\nbirth_date:\ncharisma:\ncoercion:\ncompetence:\ncompassion:\ncreativity:\ncourage:\nlevel:\nhit_points:\nSTR:\nDEX:\nCON:\nINT:\nWIS:\nCHA:\nspecies: []\ntraits: []\nabilities: []\nbirthplace: ""\nlanguages: []\nlocation: ""\nobjects: []\ninstitutions: []\nfamily: []\nfriends: []\nrivals: []\n---\n\n### Description\n\nA noble.\n${EMPTY}`;
	const r = await harnessSave({
		notes: { "Character/Ireena.md": scaffold },
		save: "Character/Ireena.md",
		answer: { [ID]: whole({ description: "A noble.", change_seq: 1 }) },
	});
	assert.ok(r.calls.some((c) => c.startsWith("create")), r.calls.join(" | ") + r.notices.join(" | "));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("★ a text property edited beside its section: the world holds the section, so the note gets no mark", async () => {
	// The note holds `x_mood: edited` as a property and `### Mood` as a section; the world holds the section's text.
	const note = pulled({ fm: "x_mood: edited\n", sections: "### Mood\n\nlight\n" });
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note, "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: whole({ description: "A noble.", x_mood: "light", change_seq: 5 }) },
	});
	assert.equal(markKey(ID) in seqOf(r), false, "the property's text is in no world copy and the note was marked: " + JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("the control of the text-property test: the section alone, saved, is marked (the render does run on this fixture)", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled() + "### Mood\n\nlight\n", "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: whole({ description: "A noble.", x_mood: "light", change_seq: 5 }) },
		answer: { [ID]: whole({ description: "A noble.", x_mood: "light", change_seq: 6 }) },
	});
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)) + r.notices.join(" | ") + bytesOf(r));
});

test("★ a hard break typed while the save ran is in no answer: layout is not tolerated in a note typed into since the read, so no mark", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ description: "first\nsecond" }),"~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: whole({ description: "first", change_seq: 5 }) },
		answer: { [ID]: whole({ description: "first\nsecond", change_seq: 6 }) },
		during: async ({ app, files }) => {
			const f = files["Character/Ireena.md"];
			await app.vault.modify(f, (await app.vault.read(f)).replace("first\nsecond", "first  \nsecond"));
		},
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.ok(bytesOf(r).includes("first  \nsecond"), "the typed hard break must still be in the note: " + bytesOf(r));
	assert.equal(markKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("★ a decimal in an integer field: keel holds the rounded number, so the note gets no mark", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ fm: "charisma: 62.5\n" }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", charisma: 60, change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble.", charisma: 62, change_seq: 6 }) },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(markKey(ID) in seqOf(r), false, "the note holds 62.5 and the world 62: " + JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("★ two links in a single-link field: the world holds one, so the note gets no mark", async () => {
	const r = await harnessSave({
		notes: { ...places, "Character/Ireena.md": pulled({ fm: `location:\n  - "[[Waterdeep]]"\n  - "[[Barovia]]"\n` }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble.", location: WATERDEEP, change_seq: 6 }) },
	});
	assert.equal(markKey(ID) in seqOf(r), false, "the second link is in no world copy and the note was marked: " + JSON.stringify(seqOf(r)) + r.notices.join(" | ") + bytesOf(r));
});

test("★ a save that left a link out leaves the note unmarked, so the next pull copies it", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ fm: `friends:\n  - "[[Nowhere]]"\n` }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble.", change_seq: 6 }) },
	});
	assert.equal(markKey(ID) in seqOf(r), false, "a link no world copy holds was marked: " + JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("★ the world's answer differs from what the note holds (the text typed while the save ran, or a rounding): no mark", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble, edited, and then some.", change_seq: 6 }) },
	});
	assert.equal(markKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("an answer that is no element (a /bulk result) leaves the note unmarked", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: { items: [] } },
	});
	assert.equal(markKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)));
});

test("★ an answer that is not the whole element (a field of its type missing) leaves the note unmarked: the render keeps what the answer omits", async () => {
	// The note holds a key of a tool's own (`atlas_color`) that the render preserves; a partial answer cannot show the world holds it.
	const partial = { id: ID, name: "Ireena", description: "A noble, edited.", change_seq: 6 };
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ fm: "atlas_color: red\n", description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: partial },
	});
	assert.equal(markKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("an answer for another id leaves the note unmarked, even one that renders to the note", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble, edited.", id: "someone-else", change_seq: 5 }) },
	});
	assert.equal(markKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)));
});

test("a note with a key of the person's own (`tags`), saved whole, is marked: the server's lines close the block in the save and in the render", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": pulled({ fm: "tags:\n  - hero\n", description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble, edited.", change_seq: 6 }) },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("a link to a note whose file name is not its element's name is rendered as the pull writes it, so the note is marked", async () => {
	const town = { "Location/City.md": `---\nname: Town\nid: ${WATERDEEP}\n---\n\n### Description\n\nA city.\n` };
	const r = await harnessSave({
		notes: { ...town, "Character/Ireena.md": pulled({ fm: 'location: "[[City]]"\n', description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: { id: ID, name: "Ireena", description: "A noble.", location: WATERDEEP, change_seq: 5 } },
		answer: { [ID]: whole({ description: "A noble, edited.", location: WATERDEEP, change_seq: 6 }) },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("★ text typed on the blank line under an empty heading, saved, leaves the note marked: only the layout differs from the world's render", async () => {
	const typed = pulled({}).replace("### Physicality\n\n\n", "### Physicality\nTall and weathered.\n\n");
	const r = await harnessSave({
		notes: { "Character/Ireena.md": typed, "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: whole({ description: "A noble.", change_seq: 5 }) },
		answer: { [ID]: whole({ description: "A noble.", physicality: "Tall and weathered.", change_seq: 6 }) },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(r.sent[0].physicality, "Tall and weathered.", JSON.stringify(r.sent));
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)) + bytesOf(r));
});

test("the control: one link that resolves, saved whole, is marked", async () => {
	const r = await harnessSave({
		notes: { ...places, "Character/Ireena.md": pulled({ fm: 'location: "[[Waterdeep]]"\n', description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: whole({ description: "A noble.", location: WATERDEEP, change_seq: 5 }) },
		answer: { [ID]: whole({ description: "A noble, edited.", location: WATERDEEP, change_seq: 6 }) },
	});
	assert.equal(seqOf(r)[markKey(ID)], noteMark(bytesOf(r)), JSON.stringify(seqOf(r)) + r.notices.join(" | ") + bytesOf(r));
});

test("a note that holds a link a save left out (one that names no note of the world) is not marked", async () => {
	// `[[Twin]]` names no element note of the world: the save leaves the link out and says the note keeps it.
	const r = await harnessSave({
		notes: { ...places, "Character/Ireena.md": pulled({ fm: 'location: "[[Twin]]"\n', description: "A noble, edited." }), "~/.ow-seq.json": JSON.stringify(OLD) },
		save: "Character/Ireena.md",
		server: { [ID]: whole({ description: "A noble.", location: WATERDEEP, change_seq: 5 }) },
		answer: { [ID]: whole({ description: "A noble, edited.", location: WATERDEEP, change_seq: 6 }) },
	});
	assert.equal(markKey(ID) in seqOf(r), false, JSON.stringify(seqOf(r)) + r.notices.join(" | ") + bytesOf(r));
});

const GROUP_NOTE =`---\nname: Ireena\nid: ${ID}\nkeepme: one\ndropme: two\n---\n\n### Description\n\nA noble, edited.\n`;

test("★ a save marks each entry of the group the answer holds, at the value the note holds, and clears a mark the answer no longer holds", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": GROUP_NOTE, "~/.ow-seq.json": JSON.stringify({ [ID]: 5, [groupMarkKey(ID, "old")]: 9 }) },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
		answer: { [ID]: { id: ID, change_seq: 6, x_properties: { keepme: "one", dropme: "two" } } },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	const idx = seqOf(r);
	assert.equal(idx[groupMarkKey(ID, "keepme")], valueMark("one"), JSON.stringify(idx));
	assert.equal(idx[groupMarkKey(ID, "dropme")], valueMark("two"), JSON.stringify(idx));
	assert.ok(!(groupMarkKey(ID, "old") in idx), "a mark for an entry the answer no longer holds stayed: " + JSON.stringify(idx));
});
