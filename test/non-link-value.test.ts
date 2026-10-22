/**
 * A non-link value never clears a link field (3.8.0, Amendment B; Boss's
 * save-path walk, h69 #10369). Another plugin's `location: [12.3, 45.6]` on
 * a Character note read as "no link", was sent as `location: null`, and keel
 * cleared the Character's real location (PATCH 200). Now a link field whose
 * note value is not a link is left out of the save payload, as an unresolved
 * name already is; an empty value still clears, a wikilink still sends.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessSave } from "./support/save-harness";
import { frontmatterToPayloadFields } from "../vault/element-transform";

const ID = "0199c000-0000-7000-8000-0000000000d1";
const VALLAKI = "0199c000-0000-7000-8000-0000000000a1";
const KREZK = "0199c000-0000-7000-8000-0000000000a2";
const vallakiNote = `---\nname: Vallaki\nid: ${VALLAKI}\n---\n`;
const ireena = (location: string) => `---\nname: Ireena\nid: ${ID}\nlocation: ${location}\n---\n\n### Description\n\nA noble.\n`;

test("★ a note carrying `location: [12.3, 45.6]` saves with no `location` key: the server link is untouched", async () => {
	const r = await harnessSave({
		notes: { "Character/Ireena.md": ireena("[12.3, 45.6]"), "Location/Vallaki.md": vallakiNote },
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "Old.", location: VALLAKI }, [VALLAKI]: { name: "Vallaki" } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent.length, 1, `sent ${JSON.stringify(r.sent)}`);
	assert.equal("location" in r.sent[0], false, `sent ${JSON.stringify(r.sent[0])}`);
	assert.equal(r.sent[0].description, "A noble.");
});

test("★ a note whose location is a resolvable wikilink still sends it", async () => {
	const r = await harnessSave({
		notes: {
			"Character/Ireena.md": ireena('"[[Vallaki]]"'),
			"Location/Vallaki.md": vallakiNote,
			"Location/Krezk.md": `---\nname: Krezk\nid: ${KREZK}\n---\n`,
		},
		save: "Character/Ireena.md",
		server: { [ID]: { name: "Ireena", description: "A noble.", location: KREZK }, [VALLAKI]: { name: "Vallaki" }, [KREZK]: { name: "Krezk" } },
	});
	assert.equal(r.result.ok, true, r.notices.join(" | "));
	assert.equal(r.sent.length, 1, `sent ${JSON.stringify(r.sent)}`);
	assert.equal(r.sent[0].location, VALLAKI);
});

test("the payload builder: a non-link value is left out of a single or a multi link; an empty value still clears", () => {
	const out = frontmatterToPayloadFields(
		{ name: "Ireena", location: [12.3, 45.6], species: [3, 4], languages: { lat: 1 }, birthplace: "", traits: [] },
		"character"
	);
	for (const k of ["location", "species", "languages"]) assert.equal(k in out, false, `${k}: ${JSON.stringify(out[k])}`);
	assert.equal(out.birthplace, null, "an emptied single link still clears");
	assert.deepEqual(out.traits, [], "an emptied multi link still clears");
	assert.equal("birthplace" in frontmatterToPayloadFields({ birthplace: 7 }, "character"), false);
	assert.equal("birthplace" in frontmatterToPayloadFields({ birthplace: true }, "character"), false);
});
