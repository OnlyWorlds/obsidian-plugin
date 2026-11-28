/**
 * #2443: saves of one note wait for each other (one reads the change number the one before recorded). Queued by path, a note
 * renamed while its first save was in flight got a second save beside it, which read the old number and was refused as stale
 * over the person's own write. Queued by the file, the second waits.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp } from "./support/obsidian-mock";
import { SaveElementCommand } from "../Commands/SaveElementCommand";

const W = "OnlyWorlds/Worlds/W";
const FOLDER = `${W}/Elements/Character`;
const ID = "019a0000-0000-7000-8000-0000000000e1";
const settle = () => new Promise((r) => setTimeout(r, 40));

test("★ a note renamed while its save is in flight: the second save waits for the first (red on 3.23.1: it ran beside it)", async () => {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "- **API Key:** ow_k_test\n");
	const file = await vault.seed(`${FOLDER}/Beta.md`, `---\nname: Beta\nid: ${ID}\n---\n\n### Description\n\nText.\n`);
	const calls: string[] = [];
	let release: () => void = () => {};
	const held = new Promise<void>((r) => (release = r));
	let updates = 0;
	const client = {
		getWorld: async () => ({ id: "019a0000-0000-7000-8000-0000000000ee" }),
		changesWalk: async () => ({ changes: [], cursor: null, head: 0 }),
		get: async () => {
			calls.push("get");
			return { id: ID, name: "old" };
		},
		update: async () => {
			calls.push("update");
			if (++updates === 1) await held;
			return {};
		},
	};
	const plugin = { settings: { apiKey: "" }, saveSettings: async () => {}, buildV2Client: async () => client };
	const first = new SaveElementCommand(app as App, plugin as never).execute(file as never);
	await settle();
	assert.deepEqual(calls, ["get", "update"], "the first save is in flight");
	vault.move(`${FOLDER}/Beta.md`, `${FOLDER}/Beta renamed.md`);
	const second = new SaveElementCommand(app as App, plugin as never).execute(file as never);
	await settle();
	assert.deepEqual(calls, ["get", "update"], "the second save read the server while the first was still in flight: " + calls.join(" | "));
	release();
	await Promise.all([first, second]);
	assert.equal(calls.filter((c) => c === "get").length, 2, "the second ran after: " + calls.join(" | "));
});
