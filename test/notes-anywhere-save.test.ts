/**
 * Save element on a note anywhere in the world's folder, and on a person's own properties
 * (the Markdown profile, sentences 1 to 4), through the real SaveElementCommand and an
 * in-memory vault and server.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";

const ID = "0199c000-0000-7000-8000-0000000000a1";
const OTHER = "0199c000-0000-7000-8000-0000000000a2";

const note = (fm: string, name = "Ireena") => `---\nname: ${name}\nid: ${ID}\n${fm}---\n\n### Description\n\nA noble.\n`;

test("★ a note outside every type folder is saved as the type its type property names", async () => {
	const r = await harnessSave({
		notes: { "~/Cast/Ireena.md": note("type: location\n") },
		save: "~/Cast/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble." } },
	});
	assert.ok(r.calls.some((c) => c.startsWith(`get location ${ID}`)) || r.calls.some((c) => c.startsWith("create location")), r.calls.join(" | ") + " :: " + r.notices.join(" | "));
	assert.ok(!r.notices.some((n) => /not a valid OnlyWorlds element note/.test(n)), r.notices.join(" | "));
});

test("a note outside every type folder with no type property is not an element note, and is not saved", async () => {
	const r = await harnessSave({
		notes: { "~/Cast/Ireena.md": note("") },
		save: "~/Cast/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble." } },
	});
	assert.equal(r.sent.length, 0);
	assert.ok(r.notices.some((n) => /not a valid OnlyWorlds element note/.test(n)), r.notices.join(" | "));
});

test("a type property in a type folder is the person's own: the note saves as its folder's type, and the property crosses in x_properties", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("type: location\n") },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble." } },
	});
	assert.ok(!r.calls.some((c) => /location/.test(c)), r.calls.join(" | "));
	assert.deepEqual(r.sent[0]?.x_properties, { type: "location" });
});

test("★ a name the note holds as a property and again inside its own x_properties is refused by name, nothing sent", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("mood: tense\nx_properties:\n  mood: calm\n  kept: 1\n") },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble." } },
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /Ireena not sent: mood is both a property of the note and inside its x_properties/.test(n)), r.notices.join(" | "));
});

test("an edit to a person's own property is sent in x_properties and nothing is sent as x_<name>", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("status: done\nmood: tense\n") },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", x_properties: { status: "draft", mood: "tense" } } },
	});
	assert.equal(r.sent.length, 1);
	assert.deepEqual(r.sent[0].x_properties, { status: "done", mood: "tense" });
	assert.equal("x_status" in r.sent[0], false);
	assert.equal("x_mood" in r.sent[0], false);
});

test("an unrelated id on a person's own note elsewhere is left alone by a save of another note", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": note(""),
			"~/Diary/Day one.md": `---\nid: ${OTHER}\nname: Day one\n---\nMy own note.\n`,
		},
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble." } },
	});
	assert.ok(!r.calls.some((c) => c.includes(OTHER)), r.calls.join(" | "));
});
