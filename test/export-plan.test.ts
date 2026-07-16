/**
 * S9 export picker — pure destination-planning logic.
 *
 * Covers the escape-the-vault path join (both separators) and the R3 external
 * refusal branches. The I/O (native picker probe, fs sink, vault sink) lives in
 * ExportFolderCommand.ts and is exercised in a running Obsidian, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	joinExternal,
	checkExternalTarget,
	ATLAS_OPEN_MARKERS,
} from "../Commands/export-plan";

test("joinExternal: Windows sep, strips trailing separators", () => {
	assert.equal(
		joinExternal("C:\\Users\\me\\onlyworlds-atlas", "aria-018f2a3b", "\\"),
		"C:\\Users\\me\\onlyworlds-atlas\\aria-018f2a3b"
	);
	assert.equal(
		joinExternal("C:\\Users\\me\\onlyworlds-atlas\\", "aria-018f2a3b", "\\"),
		"C:\\Users\\me\\onlyworlds-atlas\\aria-018f2a3b"
	);
});

test("joinExternal: POSIX sep, strips trailing slash", () => {
	assert.equal(
		joinExternal("/home/me/onlyworlds-atlas/", "aria-018f2a3b", "/"),
		"/home/me/onlyworlds-atlas/aria-018f2a3b"
	);
});

test("checkExternalTarget: clean target is allowed", () => {
	const v = checkExternalTarget("aria-018f2a3b", false, false);
	assert.equal(v.ok, true);
});

test("checkExternalTarget: existing target is refused (never overwrite)", () => {
	const v = checkExternalTarget("aria-018f2a3b", true, false);
	assert.equal(v.ok, false);
	if (!v.ok) assert.equal(v.reason, "exists");
});

test("checkExternalTarget: open-Atlas dest is refused (race class)", () => {
	const v = checkExternalTarget("aria-018f2a3b", false, true);
	assert.equal(v.ok, false);
	if (!v.ok) assert.equal(v.reason, "atlas-open");
});

test("checkExternalTarget: atlas-open takes precedence over exists", () => {
	const v = checkExternalTarget("aria-018f2a3b", true, true);
	assert.equal(v.ok, false);
	if (!v.ok) assert.equal(v.reason, "atlas-open");
});

test("ATLAS_OPEN_MARKERS are the documented dotfile/lockfile names", () => {
	assert.deepEqual([...ATLAS_OPEN_MARKERS], [".atlas", "lock"]);
});
