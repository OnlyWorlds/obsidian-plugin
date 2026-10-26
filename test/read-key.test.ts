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
import { makeApp, setRequestUrl, __modals, __notices, __requests } from "./support/obsidian-mock";
import { FakeEl } from "./support/fake-dom";
import { PinCache } from "../auth/pin-cache";
import { SaveElementCommand } from "../Commands/SaveElementCommand";
import { ExportWorldCommand } from "../Commands/ExportWorldCommand";
import { DeleteElementCommand } from "../Commands/DeleteElementCommand";
import { RenameWorldCommand } from "../Commands/RenameWorldCommand";
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

// --- Delete Element and Rename World refuse BEFORE their dialogs (Seethe's walk of rc-next) ---

const READ_ONLY_LINE = /^This world is read-only in this vault:/;

function makeActive(h: { app: App; file: TFile }): void {
	(h.app as unknown as { workspace: { getActiveFile: () => TFile | null } }).workspace.getActiveFile = () => h.file;
}

function renamePlugin(h: Awaited<ReturnType<typeof setup>>) {
	return {
		...h.plugin,
		buildV2Client: async (k: string) => {
			h.clientsBuilt.push(k);
			return null;
		},
	};
}

test("Delete Element with a read key refuses before the confirm dialog: the read-only line, no modal, no request", async () => {
	const h = await setup("ow_r_player_strahd");
	setRequestUrl(() => ({ status: 599 }));
	makeActive(h);
	await new DeleteElementCommand(h.app, h.plugin as never).execute();
	assert.equal(__modals.length, 0, "a modal opened");
	assert.deepEqual(__requests, [], "a request was sent");
	assert.deepEqual(h.clientsBuilt, []);
	assert.ok(__notices.some((n) => READ_ONLY_LINE.test(n)), __notices.join(" / "));
});

test("Delete Element with a write key still opens the typed-name confirm, and sends nothing yet", async () => {
	const h = await setup("ow_w_owner_strahd");
	setRequestUrl(() => ({ status: 599 }));
	makeActive(h);
	await new DeleteElementCommand(h.app, h.plugin as never).execute();
	assert.equal(__modals.length, 1);
	assert.equal(__modals[0].constructor.name, "DeleteConfirmModal");
	assert.deepEqual(__requests, []);
	assert.deepEqual(h.clientsBuilt, []);
	assert.ok(!__notices.some((n) => READ_ONLY_LINE.test(n)));
});

test("Rename World with a read key refuses before the rename dialog: the read-only line, no modal, no rename, no request", async () => {
	const h = await setup("ow_r_player_strahd");
	setRequestUrl(() => ({ status: 599 }));
	await new RenameWorldCommand(h.app, {}, renamePlugin(h) as never).execute();
	assert.equal(__modals.length, 0, "a modal opened");
	assert.deepEqual(__requests, [], "a request was sent");
	assert.deepEqual(h.clientsBuilt, []);
	assert.deepEqual((h.app as unknown as { renames: string[] }).renames, []);
	assert.ok(__notices.some((n) => READ_ONLY_LINE.test(n)), __notices.join(" / "));
});

test("Rename World with a write key still opens the rename dialog, and sends nothing yet", async () => {
	const h = await setup("ow_w_owner_strahd");
	setRequestUrl(() => ({ status: 599 }));
	await new RenameWorldCommand(h.app, {}, renamePlugin(h) as never).execute();
	assert.equal(__modals.length, 1);
	assert.equal(__modals[0].constructor.name, "WorldRenameModal");
	assert.deepEqual(__requests, []);
	assert.deepEqual(h.clientsBuilt, []);
	assert.ok(!__notices.some((n) => READ_ONLY_LINE.test(n)));
});

test("Rename World in a vault holding a read-key world and a write-key world offers only the writable one", async () => {
	const h = await setup("ow_r_player_strahd");
	const { vault } = h.app as unknown as { vault: { seed(p: string, c: string): Promise<unknown> } };
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **API Key:** ow_w_owner_hyperion\n");
	setRequestUrl(() => ({ status: 599 }));
	await new RenameWorldCommand(h.app, {}, renamePlugin(h) as never).execute();
	assert.equal(__modals.length, 1);
	assert.deepEqual((__modals[0] as unknown as { worlds?: string[] }).worlds, ["Hyperion"]);
	assert.deepEqual(__requests, []);
});

// --- Upload World's picker offers only writable worlds (Kael's cold read) ---

function uploadCommand(h: Awaited<ReturnType<typeof setup>>, activeWorld: string, pin: string | null) {
	const asked = { pin: false };
	const plugin = { ...h.plugin, pinCache: { get: async () => ((asked.pin = true), pin), clear: () => {} } };
	const cmd = new ExportWorldCommand(h.app, {} as never, { getWorldName: async () => activeWorld } as never, plugin as never);
	return { cmd, asked };
}

test("Upload in a vault holding a read-key world and a write-key world: the picker offers only the writable one", async () => {
	const h = await setup("ow_r_player_strahd");
	await (h.app as unknown as { vault: { seed(p: string, c: string): Promise<unknown> } }).vault.seed(
		"OnlyWorlds/Worlds/Hyperion/World.md",
		"- **API Key:** ow_w_owner_hyperion\n",
	);
	setRequestUrl(() => ({ status: 599 }));
	const { cmd } = uploadCommand(h, "Hyperion", null);
	await cmd.execute();
	assert.equal(__modals.length, 1);
	assert.equal(__modals[0].constructor.name, "WorldPinSelectionModal");
	assert.deepEqual((__modals[0] as unknown as { worlds?: string[] }).worlds, ["Hyperion"]);
	assert.deepEqual(__requests, []);
});

test("Upload in a vault whose every world is read-only refuses up front: the read-only line, no modal, no PIN, no request", async () => {
	const h = await setup("ow_r_player_strahd");
	setRequestUrl(() => ({ status: 599 }));
	// No active world named: the refusal must not rest on the active-world check.
	const { cmd, asked } = uploadCommand(h, "", "1234");
	await cmd.execute();
	assert.equal(__modals.length, 0, "a modal opened");
	assert.equal(asked.pin, false, "the PIN was asked");
	assert.deepEqual(__requests, [], "a request was sent");
	assert.ok(__notices.some((n) => READ_ONLY_LINE.test(n)), __notices.join(" / "));
});

// --- Both pickers say when read-only worlds were left out (Kael's cold read) ---

const NOT_LISTED = "Read-only worlds are not listed: their key can read but not write.";

/** Render a modal's onOpen into a FakeEl and return its text. */
async function rendered(modal: unknown): Promise<string> {
	const el = new FakeEl();
	(modal as { contentEl: unknown }).contentEl = el;
	await (modal as { onOpen(): Promise<void> }).onOpen();
	return el.allText();
}

async function seedHyperion(h: Awaited<ReturnType<typeof setup>>): Promise<void> {
	await (h.app as unknown as { vault: { seed(p: string, c: string): Promise<unknown> } }).vault.seed(
		"OnlyWorlds/Worlds/Hyperion/World.md",
		"- **API Key:** ow_w_owner_hyperion\n",
	);
}

test("Rename World's dialog says read-only worlds are not listed, and only when one was left out", async () => {
	const mixed = await setup("ow_r_player_strahd");
	await seedHyperion(mixed);
	await new RenameWorldCommand(mixed.app, {}, renamePlugin(mixed) as never).execute();
	assert.ok((await rendered(__modals[0])).includes(NOT_LISTED), "the line is missing");

	const writable = await setup("ow_w_owner_strahd");
	await new RenameWorldCommand(writable.app, {}, renamePlugin(writable) as never).execute();
	assert.ok(!(await rendered(__modals[0])).includes(NOT_LISTED), "the line shows with nothing left out");
});

test("Upload World's picker says read-only worlds are not listed, and only when one was left out", async () => {
	const mixed = await setup("ow_r_player_strahd");
	await seedHyperion(mixed);
	await uploadCommand(mixed, "Hyperion", null).cmd.execute();
	assert.ok((await rendered(__modals[0])).includes(NOT_LISTED), "the line is missing");

	const writable = await setup("ow_w_owner_strahd");
	await uploadCommand(writable, "Strahd", null).cmd.execute();
	assert.ok(!(await rendered(__modals[0])).includes(NOT_LISTED), "the line shows with nothing left out");
});
