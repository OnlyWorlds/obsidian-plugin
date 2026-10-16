/**
 * Auto-sync saves the note that changed, and says when a save failed — run
 * against the REAL AutoSyncEngine and SaveElementCommand through an in-memory
 * vault (test/support/obsidian-mock.ts) and a recording fake of the v2 client.
 *
 * ★ Row 4 of the data-paths ranking (OW Infra #166): every auto-sync timer
 * saved `workspace.getActiveFile()`, not its own file. Eight notes modified in
 * one burst hit one id ten times and seven never (hop 10 live part 1).
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { TFile, type App } from "obsidian";
import { makeApp, type MockVault } from "./support/obsidian-mock";
import { AutoSyncEngine } from "../sync/auto-sync";
import { V2ApiError } from "../client-v2";

const W = "OnlyWorlds/Worlds/W";
const FOLDER = `${W}/Elements/Character`;
const ID_A = "019a0000-0000-7000-8000-0000000000a1";
const ID_B = "019a0000-0000-7000-8000-0000000000b2";
const note = (id: string, name: string) =>
	`---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\nText of ${name}.\n`;

interface FakeClientOpts {
	/** Throw this from update (a 422, say). */
	updateError?: Error;
	/** Throw this from create. */
	createError?: Error;
	/** Ids that already exist on the server (GET answers; else 404 -> create). */
	existing?: Set<string>;
}

async function harness(opts: FakeClientOpts & { worldKey?: string | null; pin?: boolean } = {}) {
	const { app, vault } = makeApp();
	const worldKey = opts.worldKey === undefined ? "ow_k_test" : opts.worldKey;
	await vault.seed(`${W}/World.md`, worldKey ? `- **API Key:** ${worldKey}\n` : "# W\n");
	const fileA = await vault.seed(`${FOLDER}/Alpha.md`, note(ID_A, "Alpha"));
	const fileB = await vault.seed(`${FOLDER}/Beta.md`, note(ID_B, "Beta"));

	// The user is typing in Alpha; Beta changed too (another pane, a script).
	// Focus stays where the user is: opening a note is not auto-sync's to do.
	let active: TFile | null = fileA as unknown as TFile;
	const opened: string[] = [];
	(app as unknown as { workspace: unknown }).workspace = {
		getActiveFile: () => active,
		openLinkText: async (p: string) => {
			opened.push(p);
		},
	};

	const calls: string[] = [];
	const existing = opts.existing ?? new Set<string>();
	const client = {
		get: async (type: string, id: string) => {
			calls.push(`get ${type} ${id}`);
			if (existing.has(id)) return { id, name: "old" };
			throw new V2ApiError(404, "not_found", "API Error 404", null);
		},
		create: async (type: string, body: Record<string, unknown>) => {
			calls.push(`create ${type} ${String(body.id)}`);
			if (opts.createError) throw opts.createError;
			return body;
		},
		update: async (type: string, id: string, _body: Record<string, unknown>) => {
			calls.push(`update ${type} ${id}`);
			if (opts.updateError) throw opts.updateError;
			return {};
		},
	};
	const statuses: string[] = [];
	const plugin = {
		settings: { apiKey: "", debounceMs: 5, autoSync: true },
		setSyncStatus: (s: string) => statuses.push(s),
		buildV2Client: async () => (opts.pin === false ? null : client),
	};
	const engine = new AutoSyncEngine(app as App, plugin as never);
	return { app, vault: vault as MockVault, fileA, fileB, engine, calls, statuses, opened, setActive: (f: TFile | null) => (active = f) };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const schedule = (engine: AutoSyncEngine, file: unknown) =>
	(engine as unknown as { scheduleSync(f: unknown): void }).scheduleSync(file);

test("★ two notes edited within the debounce window each save their own id (row 4)", async () => {
	const h = await harness();
	schedule(h.engine, h.fileA);
	schedule(h.engine, h.fileB);
	await settle();
	const creates = h.calls.filter((c) => c.startsWith("create"));
	assert.deepEqual(creates.sort(), [`create character ${ID_A}`, `create character ${ID_B}`]);
	assert.deepEqual(h.opened, [], "auto-sync never opens a note to save it");
});

test("auto-sync saves its file even when no note is active", async () => {
	const h = await harness();
	h.setActive(null);
	schedule(h.engine, h.fileB);
	await settle();
	assert.deepEqual(h.calls, [`get character ${ID_B}`, `create character ${ID_B}`]);
});
