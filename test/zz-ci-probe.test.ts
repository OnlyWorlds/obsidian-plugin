import { test } from "node:test";
import assert from "node:assert/strict";

// A probe: this test fails on purpose, to see the check go red. Never merged.
test("ci probe: a failing test turns the check red", () => {
	assert.equal(1, 2);
});
