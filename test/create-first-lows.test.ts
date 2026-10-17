/**
 * Round C, item 14: Kael's first read of round B, lows 8 to 10, on the manual
 * Save's create-first /bulk.
 *
 * 8: no `atomic` was sent, so when one target was refused the others were
 *    created while the save reported failure. It is sent as `atomic: true`.
 * 9: /bulk with ids is a full-replace upsert: an id that appeared between the
 *    GET's 404 and the /bulk (a second device) answers 200, replaced, and that
 *    counted as a plain create. The save now says the element existed and was
 *    replaced.
 * 10: a target's own unresolved or ambiguous links were dropped without a
 *    word (the root's are named). They are named now.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";

const IREENA = "0199c000-0000-7000-8000-0000000000e1";
const KOLYAN = "0199c000-0000-7000-8000-0000000000e2";

const notes = (kolyanLinks = "") => ({
	"Character/Ireena.md": `---\nname: Ireena\nid: ${IREENA}\nfriends:\n  - "[[Kolyan]]"\n---\n\n### Description\n\nA noble.\n`,
	"Character/Kolyan.md": `---\nname: Kolyan\nid: ${KOLYAN}\n${kolyanLinks}---\n\n### Description\n\nA burgomaster.\n`,
});
const server = { [IREENA]: { name: "Ireena", description: "A noble." } };

test("★ the create-first /bulk is sent atomic: one refused target creates none of them", async () => {
	const r = await harnessSave({ notes: notes(), save: "Character/Ireena.md", server });
	assert.ok(r.calls.includes("bulk"), r.calls.join(" | "));
	assert.deepEqual(r.bulkOpts, [{ atomic: true }]);
});

test("★ a target that answers 200 is named as existed and replaced", async () => {
	const r = await harnessSave({
		notes: notes(),
		save: "Character/Ireena.md",
		server,
		bulkStatus: (id) => (id === KOLYAN ? 200 : 201),
	});
	assert.equal(r.result.ok, true);
	assert.ok(
		r.notices.some((n) => /Character "Kolyan" was already on onlyworlds\.com/.test(n) && /replaced/.test(n)),
		r.notices.join(" | ")
	);
});

test("★ a target's own unresolved links are named, not dropped without a word", async () => {
	const r = await harnessSave({ notes: notes('rivals:\n  - "[[Nowhere]]"\n'), save: "Character/Ireena.md", server });
	assert.equal(r.result.ok, true);
	assert.ok(
		r.notices.some((n) => n.includes('Character "Kolyan"') && n.includes("Nowhere") && /not sent/.test(n)),
		r.notices.join(" | ")
	);
});
