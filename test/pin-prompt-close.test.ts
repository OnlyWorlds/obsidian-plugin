/**
 * The PIN prompt closed unanswered (Escape, or the X) answers null, as its
 * Cancel button does (Seethe's walk of PR 11). Before: the save
 * waiting on the prompt waited forever, no notice, and Save element pressed
 * again opened nothing until Obsidian reloaded. Obsidian runs a modal's
 * onClose for every way it closes; the test calls it as Escape does.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __modals, __notices } from "./support/obsidian-mock";
import { PinCache } from "../auth/pin-cache";
import { SaveElementCommand } from "../Commands/SaveElementCommand";

type Closable = { onClose(): void };

/** The prompt PinCache opened, closed as Escape or the X close it. */
function escape(): void {
	const m = __modals.pop() as unknown as Closable | undefined;
	assert.ok(m, "no prompt opened");
	m.onClose();
}

test("★ the PIN prompt closed with Escape or the X answers null, once, and the next ask opens a new prompt", async () => {
	const { app } = makeApp();
	const cache = new PinCache(app as App);
	__modals.length = 0;
	const first = cache.get();
	assert.equal(__modals.length, 1);
	const m = __modals[0] as unknown as Closable;
	escape();
	assert.equal(await first, null);
	m.onClose(); // a second close is no second answer
	const second = cache.get();
	assert.equal(__modals.length, 1, "the next ask opened no prompt");
	escape();
	assert.equal(await second, null);
});

test("★ Save element with no PIN set: the prompt closed with Escape cancels the save, with the Cancel button's line", async () => {
	const { app, vault } = makeApp();
	const W = "OnlyWorlds/Worlds/Strahd";
	await vault.seed(`${W}/World.md`, "- **API Key:** ow_w_owner_strahd\n");
	const file = (await vault.seed(
		`${W}/Elements/Character/Ireena.md`,
		"---\nname: Ireena\nid: 019a0000-0000-7000-8000-0000000000b1\n---\n\n### Description\n\nA noble.\n"
	)) as unknown as TFile;
	const pinCache = new PinCache(app as App);
	const plugin = {
		settings: { apiKey: "", apiPin: "", debounceMs: 5, autoSync: true },
		pinCache,
		setSyncStatus: () => {},
		buildV2Client: async () => ((await pinCache.get()) ? {} : null),
	};
	__modals.length = 0;
	__notices.length = 0;
	const run = new SaveElementCommand(app as App, plugin as never).execute(file, { manual: true });
	while (__modals.length === 0) await new Promise((r) => setImmediate(r));
	escape();
	const result = await Promise.race([run, new Promise((r) => setTimeout(() => r("still waiting"), 2000))]);
	assert.notEqual(result, "still waiting", "the save waits forever on a closed prompt");
	assert.deepEqual(result, { ok: false, reason: "Save cancelled: PIN not provided." });
});
