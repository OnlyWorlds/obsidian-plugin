/**
 * #2362: a string `x_` key is written ONCE, as its `###` section (the Markdown profile, OPEN 15 as ruled by Skeld 2026-11-28),
 * and a note holding the key as a property AND a section is read as one when the two are equal and refused, by name, when they
 * differ. A heading a note already holds for a key is kept by a pull (`### My notes` is not made `### My Notes`).
 * The key stays a property, written once there, when its section would not read back as the same key.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { harnessSave } from "./support/save-harness";
import { readElement, readRefusal, writeElement } from "../vault/element-file";
import { bodyTextFields, writesAsSection } from "../vault/element-transform";

const ID = "0199c000-0000-7000-8000-0000000000c1";
const PATH = "OnlyWorlds/Worlds/W/Elements/Character/Ireena.md";
const head = (fm: string) => `---\nname: Ireena\nid: ${ID}\n${fm}---\n\n### Description\n\nA noble.\n`;

async function written(existing: string | null, data: Record<string, unknown>) {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/W/World.md", "- **API Key:** ow_k_test\n");
	if (existing !== null) await vault.seed(PATH, existing);
	const file = await writeElement(app, "W", "character", ID, { name: "Ireena", description: "A noble.", ...data });
	return { app, vault, file, text: await vault.read(file as never) };
}

test("the fixture's own type has the field the 'label is a field's own' row names", () => {
	assert.ok(bodyTextFields("character").includes("reputation"), bodyTextFields("character").join(","));
});

test("★ writesAsSection: a key whose section reads back as itself, and only that", () => {
	const yes = (k: string, v: unknown = "text") => writesAsSection(k, v, "character");
	assert.ok(yes("x_looks"));
	assert.ok(yes("x_looks", ""), "an empty text is a section too: the scaffold");
	assert.ok(yes("x_my_notes"));
	assert.ok(yes("x_a_b_c"), "three words: the reader's limit");
	assert.ok(!yes("x_NPC_list"), "a capital would come back x_npc_list");
	assert.ok(!yes("x_npc__list"), "a doubled underscore would come back with one");
	assert.ok(!yes("x_looks_"), "a trailing underscore would come back without it");
	assert.ok(!yes("x_a_b_c_d"), "four words read as prose, not a field");
	assert.ok(!yes("x_reputation"), "its label is a field the type already has");
	assert.ok(!yes("x_description"));
	assert.ok(!yes("x_properties"), "the group's own key");
	assert.ok(!yes("x_depends_on"), "the generated section's heading");
	assert.ok(!yes("x_"), "no words");
	assert.ok(!yes("x_looks", 3) && !yes("x_looks", ["a"]) && !yes("x_looks", null), "only a string");
	assert.ok(!yes("x_ruler", "0199c000-0000-7000-8000-0000000000a1"), "an element id is a link property");
	assert.ok(!yes("atlas_looks") && !yes("looks"), "only the person's own x_ keys");
	assert.ok(!yes("x_café"), "a letter the reader's heading test does not take");
});

test("★ a pull writes a string x_ key once: the section, and no property (red on 3.23.1)", async () => {
	const w = await written(null, { x_looks: "Tall." });
	assert.ok(w.text.includes("### Looks\n\nTall.\n"), w.text);
	assert.ok(!w.text.includes("x_looks"), "a second copy as a property:\n" + w.text);
});

test("★ a pull over an old doubled note makes it single: the property copy goes, the section stays (red on 3.23.1)", async () => {
	const w = await written(head("x_looks: Tall.\n") + "\n### Looks\n\nTall.\n", { x_looks: "Tall." });
	assert.ok(w.text.includes("### Looks\n\nTall.\n"), w.text);
	assert.ok(!w.text.includes("x_looks"), w.text);
});

test("a key that would not read back stays a property, once, with no section", async () => {
	const w = await written(null, { x_NPC_list: "Ana, Bo", x_reputation: "good", x_a_b_c_d: "long" });
	assert.ok(w.text.includes("x_NPC_list: Ana, Bo\n"), w.text);
	assert.ok(w.text.includes("x_reputation: good\n") && w.text.includes("x_a_b_c_d: long\n"), w.text);
	assert.ok(!/### Npc List/i.test(w.text) && !w.text.includes("### A B C D"), w.text);
	assert.equal((w.text.match(/### Reputation/g) ?? []).length, 1, "the type's own Reputation section, once:\n" + w.text);
});

test("★ a pull keeps the heading a note already holds (### My notes), and capitalizes only a heading it writes new (red on 3.23.1)", async () => {
	const w = await written(head("") + "\n### My notes\n\nold\n\n### reputation\n\nfine\n", { x_my_notes: "new", x_fresh_one: "x", reputation: "fine" });
	assert.ok(w.text.includes("### My notes\n\nnew\n"), w.text);
	assert.ok(!w.text.includes("### My Notes"), w.text);
	assert.ok(w.text.includes("### reputation\n\nfine\n") && !w.text.includes("### Reputation"), "a field's heading the person typed in lower case: kept\n" + w.text);
	assert.ok(w.text.includes("### Fresh One\n\nx\n"), "a heading written new takes the label's capitals\n" + w.text);
});

test("the heading kept is the first of its key, and a second pull changes no byte", async () => {
	const first = await written(head("") + "\n### My notes\n\nold\n", { x_my_notes: "new" });
	const second = await writeElement(first.app, "W", "character", ID, { name: "Ireena", description: "A noble.", x_my_notes: "new" });
	assert.equal(await first.vault.read(second as never), first.text);
});

test("★ a property and a section with equal text read as one, nothing refused", async () => {
	const { app, vault } = makeApp();
	const f = await vault.seed(PATH, head("x_looks: Tall.\n") + "\n### Looks\n\nTall.\n");
	const read = await readElement(app, f as never);
	assert.ok(read);
	assert.equal(read.fields.x_looks, "Tall.");
	assert.equal(read.twinTexts, undefined);
	assert.equal(readRefusal(read, "Ireena"), null);
});

test("★ a property and a section with different text are refused, naming the key (red on 3.23.1)", async () => {
	const { app, vault } = makeApp();
	const f = await vault.seed(PATH, head("x_looks: Edited.\n") + "\n### Looks\n\nTall.\n");
	const read = await readElement(app, f as never);
	assert.ok(read);
	assert.deepEqual(read.twinTexts, ["x_looks"]);
	const said = readRefusal(read, "Ireena", "not saved", "Nothing was sent.");
	assert.ok(said && said.includes("x_looks") && /both a property of the note and a ### section/.test(said) && said.endsWith("Nothing was sent."), String(said));
});

test("a text that differs only in its trailing space is the same text", async () => {
	const { app, vault } = makeApp();
	const f = await vault.seed(PATH, head("x_looks: Tall.\n") + "\n### Looks\n\nTall. \n");
	const read = await readElement(app, f as never);
	assert.equal(read?.twinTexts, undefined);
});

test("★ Save refuses the doubled note whose copies differ, with the word, and sends nothing (red on 3.23.1: sent the section, lost the edit)", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": head("x_looks: Edited.\n") + "\n### Looks\n\nTall.\n" },
		save: "Character/Ireena.md",
		manual: false, // auto-sync refuses; Save element asks (twin-choice.test.ts)
		server: { [ID]: { name: "Ireena", description: "A noble.", x_looks: "Tall.", change_seq: 5 } },
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => n.includes("x_looks") && n.includes("both a property of the note and a ### section")), r.notices.join(" | "));
});

test("a doubled note whose copies agree is saved as one text, edited in either place only if both are", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": head("x_looks: Short.\n") + "\n### Looks\n\nShort.\n" },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", x_looks: "Tall.", change_seq: 5 } },
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(r.sent[0].x_looks, "Short.");
});
