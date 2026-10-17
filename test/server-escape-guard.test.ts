/**
 * Round C fix round, the keeper's amendment to items 1 and 3 (Kael's second
 * read): the reversible backslash scheme cannot make a note from before it
 * round-trip. 3.5.0 wrote no escape, so a typed `\### x` sits on disk and on
 * the server as `\### x`, and now reads as `### x`. Save reads the server
 * first: when the value read differs from the server's only by one removed
 * backslash before a `###` or fence line, the server's value is kept.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";

const ID = "0199c000-0000-7000-8000-0000000000f5";
const note = (description: string, background = "Old.") =>
	`---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\n${description}\n\n### Background\n\n${background}\n`;

test("★ a typed `\\###` line the server already holds is not sent without its backslash", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("Intro.\n\\### typed") },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "Intro.\n\\### typed", background: "Old." } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.deepEqual(r.sent, [], `sent ${JSON.stringify(r.sent)}`);
});

test("★ the same for a fence line, under auto-sync too, while another field's change still goes", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("Scene.\n  \\~~~\nOn.", "New.") },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "Scene.\n  \\~~~\nOn.", background: "Old." } },
		manual: false,
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent.length, 1);
	assert.equal("description" in r.sent[0], false, `sent ${JSON.stringify(r.sent[0])}`);
	assert.equal(r.sent[0].background, "New.");
});

test("an edit beside the escaped line is sent, as read", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": note("Intro, edited.\n\\### typed") },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "Intro.\n\\### typed", background: "Old." } },
	});
	assert.equal(r.sent[0]?.description, "Intro, edited.\n### typed");
});
