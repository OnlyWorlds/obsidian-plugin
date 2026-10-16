/**
 * A read key (`ow_r_`) never writes and never asks for a PIN (Kael's review of
 * rc-next 3c2780f, finding 3.1). A vault holds one after a player link, as a
 * guest, or as a member with no account PIN. Before: Save, Delete, Upload and
 * auto-sync went straight to the PIN prompt, which opened on every edit, and
 * any PIN then met a 401/403.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App, TFile } from "obsidian";
import { makeApp, __modals, __notices } from "./support/obsidian-mock";
import { PinCache } from "../auth/pin-cache";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { AutoSyncEngine } from "../sync/auto-sync";
import { classifyWorldKey } from "../vault/world-key-core";

const W = "OnlyWorlds/Worlds/Strahd";
const ID = "019a0000-0000-7000-8000-0000000000a1";
const NOTE = `---\nname: Ireena\nid: ${ID}\n---\n\n### Description\n\nA noble.\n`;

async function setup(key: string) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, `- **API Key:** ${key}\n`);
	const file = await vault.seed(`${W}/Elements/Character/Ireena.md`, NOTE);
	const pinCache = new PinCache(app); // the real one: its prompt is a modal
	const clientsBuilt: string[] = [];
	const statuses: string[] = [];
	const plugin = {
		settings: { apiKey: "", apiPin: "", debounceMs: 5, autoSync: true },
		pinCache,
		setSyncStatus: (s: string) => statuses.push(s),
		buildV2Client: async (k: string) => {
			clientsBuilt.push(k);
			await pinCache.get();
			return null;
		},
	};
	__modals.length = 0;
	__notices.length = 0;
	return { app: app as App, file: file as unknown as TFile, plugin, clientsBuilt, statuses };
}

test("classifyWorldKey marks an ow_r_ key read-only, and only that", () => {
	assert.equal(classifyWorldKey("ow_r_abc", undefined).readOnly, true);
	assert.equal(classifyWorldKey("ow_w_abc", undefined).readOnly, false);
	assert.equal(classifyWorldKey("0000000011", undefined).readOnly, false);
	assert.equal(classifyWorldKey(null, "ow_r_settings").readOnly, true);
});

test("Save with a read key refuses before any PIN: a plain line, no modal, no client", async () => {
	const h = await setup("ow_r_player_strahd");
	const result = await new SaveElementCommand(h.app, h.plugin as never).execute(h.file);
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.reason, /^This world is read-only in this vault:/);
	assert.deepEqual(h.clientsBuilt, []);
	assert.equal(__modals.length, 0, "a modal opened");
});

test("auto-sync skips a read-key world silently: status idle, no modal, no client, no notice", async () => {
	const h = await setup("ow_r_player_strahd");
	const engine = new AutoSyncEngine(h.app, h.plugin as never);
	(engine as unknown as { scheduleSync(f: unknown): void }).scheduleSync(h.file);
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(h.statuses.at(-1), "idle");
	assert.deepEqual(h.clientsBuilt, []);
	assert.equal(__modals.length, 0, "a modal opened");
	assert.deepEqual(__notices, []);
});

test("Upload with a read key refuses before the PIN is asked", async () => {
	const h = await setup("ow_r_player_strahd");
	let pinAsked = false;
	const plugin = { ...h.plugin, pinCache: { get: async () => ((pinAsked = true), "1234"), clear: () => {} } };
	const cmd = new ExportWorldCommand(h.app, {} as never, { getWorldName: async () => "Strahd" } as never, plugin as never);
	await cmd.execute();
	assert.equal(pinAsked, false, "the PIN was asked");
	assert.equal(__modals.length, 0, "a modal opened");
	assert.ok(__notices.some((n) => /^This world is read-only in this vault:/.test(n)));
});
