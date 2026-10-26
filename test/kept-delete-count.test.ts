/**
 * Seethe's chapter run on 3.5.1: a fresh vault's
 * first download walked the world's whole history and said "7 elements deleted
 * on the server — their notes were kept" with no note in the vault. The notice
 * counts only deletes whose element has a note of its own here; an id a note
 * merely links to is not a kept note (Kael's read).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { keptDeleteCount } from "../sync/deleted-on-server";

const A = "019e0000-0000-7000-8000-0000000000a1";
const B = "019e0000-0000-7000-8000-0000000000b2";
const C = "019e0000-0000-7000-8000-0000000000c3";

test("★ a fresh vault's first download: deletes in the history, no notes here, no notice", () => {
	const walk = [{ id: A, op: "delete" }, { id: B, op: "delete" }, { id: C, op: "upsert" }];
	assert.equal(keptDeleteCount(walk, new Set()), 0);
});

test("a delete whose element has a note here counts; one that is only linked to by a note does not", () => {
	const walk = [{ id: A, op: "delete" }, { id: B, op: "delete" }, { id: C, op: "upsert" }];
	const own = new Set([A, C]); // A's note exists; B is only a raw-id link in some note's Properties
	assert.equal(keptDeleteCount(walk, own), 1);
});

test("an upsert of an id with a note here is not a delete", () => {
	assert.equal(keptDeleteCount([{ id: C, op: "upsert" }], new Set([C])), 0);
});
