/**
 * World-key resolution — the pure decision core (classifyWorldKey).
 *
 * The load-bearing branch is 'local': an explicit local-only world must NEVER
 * fall back to the settings key. A local world syncing through the settings key
 * would write its elements into whatever world that key names (the wrong-world
 * class, hit live 2026-07-12) — and RenameWorld would rename that other world
 * on the server. The vault IO (reading World.md) lives in resolveWorldKey and
 * is exercised in a running Obsidian, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyWorldKey, LOCAL_WORLD_KEY_TOKEN } from "../vault/world-key-core";

test("own World.md key wins over settings key", () => {
	const r = classifyWorldKey("ow_r_abc123", "ow_w_settings");
	assert.equal(r.apiKey, "ow_r_abc123");
	assert.equal(r.source, "world-file");
	assert.equal(r.ownWorld, true);
});

test("classic 10-digit key resolves as world-file", () => {
	const r = classifyWorldKey("0000000011", undefined);
	assert.equal(r.apiKey, "0000000011");
	assert.equal(r.source, "world-file");
});

test("'local' token: no key, source local-world, ownWorld true", () => {
	const r = classifyWorldKey(LOCAL_WORLD_KEY_TOKEN, undefined);
	assert.equal(r.apiKey, null);
	assert.equal(r.source, "local-world");
	assert.equal(r.ownWorld, true);
});

test("'local' NEVER falls back to the settings key — the wrong-world guard", () => {
	const r = classifyWorldKey("local", "ow_w_someOtherWorldsKey");
	assert.equal(r.apiKey, null);
	assert.equal(r.source, "local-world");
});

test("'local' is case-insensitive and whitespace-tolerant", () => {
	assert.equal(classifyWorldKey("Local", "fallback").source, "local-world");
	assert.equal(classifyWorldKey("  LOCAL  ", "fallback").source, "local-world");
});

test("absent own key + settings key = settings fallback, flagged not-own", () => {
	const r = classifyWorldKey(null, "ow_w_settings");
	assert.equal(r.apiKey, "ow_w_settings");
	assert.equal(r.source, "settings");
	assert.equal(r.ownWorld, false);
});

test("empty/whitespace own key behaves as absent (settings fallback preserved)", () => {
	const r = classifyWorldKey("   ", "ow_w_settings");
	assert.equal(r.source, "settings");
});

test("nothing anywhere = none", () => {
	const r = classifyWorldKey(null, undefined);
	assert.equal(r.apiKey, null);
	assert.equal(r.source, "none");
	assert.equal(r.ownWorld, false);
});

test("settings key that is only whitespace does not count as a fallback", () => {
	const r = classifyWorldKey(null, "   ");
	assert.equal(r.source, "none");
});
