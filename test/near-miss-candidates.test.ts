/**
 * Round C fix round, item 5 (Kael's c-read, low 6): the near-miss notice
 * named `factions` on a Creature as a likely `actions`. The notice exists for
 * a link that would silently miss, so its candidates are only the type's
 * LINK fields, one edit or a plural/singular slip away; several candidates or
 * none, no notice. And a slip keeps the first letter: no type has two link
 * fields one key could slip toward, so that rule alone never dropped
 * `factions` (departure from the brief, said in the report).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { likelyLinkField } from "../vault/element-transform";

test("★ `factions` on a Creature is no slip for `actions`", () => {
	assert.equal(likelyLinkField("creature", "factions"), null);
});

test("a slip that changes the first letter is not named; one that keeps it is", () => {
	assert.equal(likelyLinkField("character", "riends"), null);
	assert.equal(likelyLinkField("character", "friend"), "friends");
	assert.equal(likelyLinkField("character", "Rivals"), "rivals");
	assert.equal(likelyLinkField("character", "ability"), "abilities");
});

test("only link fields are candidates: a slip of a text field is not named", () => {
	assert.equal(likelyLinkField("character", "backgrounds"), null);
});
