/**
 * A note that loses its last own property: Save clears the world's group (the Markdown profile, sentence 4),
 * through the real SaveElementCommand and an in-memory vault and server. The clearing rides only on a note whose
 * change_seq is known, so it is sent under If-Match and a group the note never held is not removed.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";
import { apiDataToFrontmatter, withGroupCleared } from "../vault/element-transform";

const ID = "0199c000-0000-7000-8000-0000000000b1";

const note = (fm: string) => `---\nname: Ireena\nid: ${ID}\n${fm}---\n\n### Description\n\nA noble.\n`;
const SEQ_INDEX = { "~/.ow-seq.json": JSON.stringify({ [ID]: 5 }) };
const held = (group: unknown, seq = 5) => ({ [ID]: { name: "Ireena", description: "A noble.", change_seq: seq, x_properties: group } });

test("★ the last own property deleted in a note whose seq is known: the save clears the group", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.equal(r.sent[0].x_properties, null);
});

test("a note that keeps an entry of the group (its own x_properties) sends the group with it, never null", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("x_properties:\n  kept: 1\n"), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: held({ status: "draft", kept: 1 }),
	});
	assert.equal(r.sent.length, 1, r.notices.join(" | "));
	assert.deepEqual(r.sent[0].x_properties, { kept: 1 });
});

test("a note with no seq known never clears a group it may not have held", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("") },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /already up to date/.test(n)), r.notices.join(" | "));
});

test("an element that moved since the note was pulled is refused as stale, the group untouched", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: held({ status: "draft" }, 6),
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
});

test("a note and an element with no group at all: nothing is sent", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note(""), ...SEQ_INDEX },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", change_seq: 5 } },
	});
	assert.equal(r.sent.length, 0, JSON.stringify(r.sent));
	assert.ok(r.notices.some((n) => /already up to date/.test(n)), r.notices.join(" | "));
});

test("withGroupCleared adds the clearing only when guarded and only when the payload holds no group", () => {
	assert.deepEqual(withGroupCleared({ name: "A" }, true), { name: "A", x_properties: null });
	assert.deepEqual(withGroupCleared({ name: "A" }, false), { name: "A" });
	assert.deepEqual(withGroupCleared({ name: "A", x_properties: { k: 1 } }, true), { name: "A", x_properties: { k: 1 } });
});

test("the pull of an element whose group the world has cleared writes no x_properties line", () => {
	const fm = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: null }, "character", ID);
	assert.equal("x_properties" in fm, false, JSON.stringify(fm));
	const empty = apiDataToFrontmatter({ id: ID, name: "Ireena", x_properties: {} }, "character", ID);
	assert.equal("x_properties" in empty, false, JSON.stringify(empty));
});
