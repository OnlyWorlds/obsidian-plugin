/**
 * Round C, item 5: Upload World still sent links TO elements deleted on
 * onlyworlds.com when no note here held them (a raw id a note kept), and keel
 * refused each such note whole (Kael's delta read, note 10: E-8b). Now every
 * id the deleted list names, and that is not being created again, is taken out
 * of every payload's links, and the summary names it, as Leave out does.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessUpload } from "./support/upload-harness";

const AKRAGAS = "019a0000-0000-7000-8000-0000000000c1";
const GELA = "019a0000-0000-7000-8000-0000000000c2";
const SYRACUSE = "019a0000-0000-7000-8000-0000000000c3";
const note = (id: string, name: string, links = "") =>
	`---\nname: ${name}\nid: ${id}\n${links}---\n\n### Description\n\nA city.\n`;

const FEED = [
	{ op: "upsert", type: "location", id: AKRAGAS, change_seq: 1, element: { id: AKRAGAS, name: "Akragas" } },
	{ op: "upsert", type: "location", id: GELA, change_seq: 2, element: { id: GELA, name: "Gela" } },
	{ op: "delete", type: "location", id: GELA, change_seq: 3 },
];

test("★ a raw-id link to a deleted element with no note here is left out of new and existing notes, and named", async () => {
	const r = await harnessUpload({
		notes: {
			"Location/Akragas.md": note(AKRAGAS, "Akragas", `parent_location: ${GELA}\n`),
			"Location/Syracuse.md": note(SYRACUSE, "Syracuse", `parent_location: ${GELA}\n`),
		},
		changes: FEED,
	});
	assert.ok(r.patches[AKRAGAS], "Akragas was not updated");
	assert.equal("parent_location" in r.patches[AKRAGAS], false, "the existing note still links the deleted element");
	const syracuse = r.bulkSent.find((e) => e.id === SYRACUSE);
	assert.ok(syracuse, "Syracuse was not sent");
	assert.equal("parent_location" in syracuse, false, "the new note still links the deleted element");
	assert.ok(r.notices.some((n) => /Links to Location "Gela" left out of 2 notes/.test(n)), r.notices.join(" | "));
});

test("a multi-link keeps its other ids; an id only on the stored list counts too", async () => {
	const OLD = "019a0000-0000-7000-8000-0000000000c9";
	const r = await harnessUpload({
		notes: {
			"Location/Akragas.md": note(AKRAGAS, "Akragas"),
			"Location/Syracuse.md": note(SYRACUSE, "Syracuse", `extraction_markets:\n  - ${AKRAGAS}\n  - ${OLD}\n`),
		},
		changes: FEED.slice(0, 1),
		deleted: [OLD],
	});
	const syracuse = r.bulkSent.find((e) => e.id === SYRACUSE);
	assert.ok(syracuse, "Syracuse was not sent");
	assert.deepEqual(syracuse.extraction_markets, [AKRAGAS]);
	assert.ok(r.notices.some((n) => n.includes(`an element deleted there (${OLD})`)), r.notices.join(" | "));
});
