/**
 * The Bases file, round 2 (OW Infra #188): what the plugin says and does when
 * it keeps a world's base, when a world is renamed, the first base it writes,
 * a name differing only in case. Kael's cold read of bases-188, should-fix 2
 * and 3, lows 4 to 6.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { WriteBasesFileCommand } from "../Commands/WriteBasesFileCommand";
import { RenameWorldCommand } from "../Commands/RenameWorldCommand";
import { pluginBasesSchema, writeWorldBasesFile } from "../vault/bases-writer";
import { buildBasesFile } from "../vault/bases-file";
import { DEFAULT_SETTINGS, type OnlyWorldsPluginSettings } from "../settings/settings";

const WORLD_ID = "0199b000-0000-7000-8000-0000000000aa";
const CHAR_ID = "0199b000-0000-7000-8000-0000000000c1";
const BASE = "OnlyWorlds/Worlds/Hyperion/Hyperion.base";
const KEPT_NOTICE =
	"Your Bases file for Hyperion has your own changes, so it was left as is; delete it or run Write Bases file to rebuild it.";

type MockApp = ReturnType<typeof makeApp>;

function serveHyperion(): void {
	setRequestUrl((r) => {
		const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
		if (path === "/world") return { status: 200, json: { id: WORLD_ID, name: "Hyperion", description: "" } };
		if (path === "/changes")
			return {
				status: 200,
				json: {
					cursor: "c",
					has_more: false,
					head: 1,
					changes: [
						{ op: "upsert", type: "character", id: CHAR_ID, change_seq: 1, updated_at: "x", element: { id: CHAR_ID, name: "Kassad" } },
					],
				},
			};
		return { status: 404, json: {} };
	});
}

/** One plugin for the whole test: its settings persist across downloads, as data.json does. */
function makePlugin(over: Partial<OnlyWorldsPluginSettings> = {}) {
	const p = {
		settings: { ...DEFAULT_SETTINGS, syncCursors: {}, ...over } as OnlyWorldsPluginSettings,
		saves: 0,
		saveSettings: async () => {
			p.saves++;
		},
	};
	return p;
}

async function download(app: MockApp["app"], plugin: ReturnType<typeof makePlugin>): Promise<string | null> {
	serveHyperion();
	return new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_r_k", "");
}

function editBase(vault: MockApp["vault"]): string {
	const edited = vault.contentAt(BASE)!.replace('name: "Characters"', 'name: "People"');
	void vault.modify(vault.files.get(BASE)!.file, edited);
	return edited;
}

// ── Item 1: a base someone changed stops updating, and the plugin says so once ──

test("Download keeps a changed base and says so in a Notice, once per world, remembered in settings", async () => {
	const { app, vault } = makeApp();
	const plugin = makePlugin();
	await download(app, plugin);
	const edited = editBase(vault);

	__notices.length = 0;
	await download(app, plugin);
	assert.equal(vault.contentAt(BASE), edited, "the user's changes are kept");
	assert.ok(__notices.includes(KEPT_NOTICE), __notices.join(" / "));
	assert.deepEqual(plugin.settings.basesKeptNoticed, ["Hyperion"]);

	__notices.length = 0;
	await download(app, plugin);
	assert.equal(vault.contentAt(BASE), edited);
	assert.equal(__notices.includes(KEPT_NOTICE), false, "the Notice shows once, not on every Download");
});

test("the remembered Notice is forgotten once the plugin owns the file again, and shows for a new change", async () => {
	const { app, vault } = makeApp();
	const plugin = makePlugin();
	await download(app, plugin);
	editBase(vault);
	await download(app, plugin);
	assert.deepEqual(plugin.settings.basesKeptNoticed, ["Hyperion"]);

	vault.files.delete(BASE); // the user deletes it; the next Download writes a fresh one
	await download(app, plugin);
	assert.ok(vault.contentAt(BASE));
	assert.deepEqual(plugin.settings.basesKeptNoticed, []);

	editBase(vault);
	__notices.length = 0;
	await download(app, plugin);
	assert.ok(__notices.includes(KEPT_NOTICE), __notices.join(" / "));
});

test("the default settings remember no world", () => {
	assert.deepEqual(DEFAULT_SETTINGS.basesKeptNoticed, []);
});

test("Write Bases file rebuilds a changed base, and keeps the user's version beside it, unmarked", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "created");
	const fresh = vault.contentAt(BASE)!;
	const edited = editBase(vault);
	(app.workspace as unknown as { getActiveFile: () => unknown }).getActiveFile = () => vault.files.get(BASE)!.file;

	__notices.length = 0;
	await new WriteBasesFileCommand(app).execute();
	assert.equal(vault.contentAt(BASE), fresh, "rebuilt to the plugin's text");
	const copy = vault.contentAt("OnlyWorlds/Worlds/Hyperion/Hyperion (your copy).base");
	assert.equal(copy, edited.split("\n").slice(1).join("\n"), "the user's version, without the plugin's first line");
	assert.ok(
		__notices.some((n) => n.includes("rebuilt") && n.includes("Hyperion (your copy).base")),
		__notices.join(" / ")
	);
	// The copy is the user's from now on: a Download never touches it, never counts it as the world's base.
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "unchanged");
	assert.equal(vault.contentAt("OnlyWorlds/Worlds/Hyperion/Hyperion (your copy).base"), copy);
});

// ── Item 2: Rename World leaves an empty base; Download writes a second one ──

const NEW_BASE = "OnlyWorlds/Worlds/Endymion/Endymion.base";

function basesUnder(vault: MockApp["vault"], folder: string): string[] {
	return [...vault.files.keys()].filter((p) => p.startsWith(folder + "/") && p.endsWith(".base")).sort();
}

async function renameHyperion(app: MockApp["app"], plugin?: ReturnType<typeof makePlugin>): Promise<void> {
	(app as unknown as { realRenames: boolean }).realRenames = true;
	const cmd = new RenameWorldCommand(app, { version: "t" }, plugin as never);
	await cmd.renameWorldFile("Hyperion", "Endymion");
	await cmd.renameWorldFolder("Hyperion", "Endymion");
}

function endymionText(): string {
	return buildBasesFile({ worldName: "Endymion", worldFolderPath: "OnlyWorlds/Worlds/Endymion", schema: pluginBasesSchema() });
}

test("Rename World rewrites the plugin's own base to the new folder and names it after the world", async () => {
	const { app, vault } = makeApp();
	const plugin = makePlugin();
	await download(app, plugin);
	await renameHyperion(app, plugin);
	assert.deepEqual(basesUnder(vault, "OnlyWorlds/Worlds/Endymion"), [NEW_BASE]);
	assert.equal(vault.contentAt(NEW_BASE), endymionText());
	assert.match(vault.contentAt(NEW_BASE)!, /file\.inFolder\("OnlyWorlds\/Worlds\/Endymion\/Elements"\)/);
});

test("Rename World leaves a changed base as is and says so, naming the rename", async () => {
	const { app, vault } = makeApp();
	const plugin = makePlugin();
	await download(app, plugin);
	const edited = editBase(vault);
	__notices.length = 0;
	await renameHyperion(app, plugin);
	assert.deepEqual(basesUnder(vault, "OnlyWorlds/Worlds/Endymion"), ["OnlyWorlds/Worlds/Endymion/Hyperion.base"]);
	assert.equal(vault.contentAt("OnlyWorlds/Worlds/Endymion/Hyperion.base"), edited);
	const said = __notices.find((n) => n.startsWith("Your Bases file for Endymion has your own changes"));
	assert.ok(said && said.includes("renamed"), __notices.join(" / "));
	assert.deepEqual(plugin.settings.basesKeptNoticed, ["Endymion"]);
});

test("a folder renamed by hand: Download's writer moves the plugin's base, never writes a second one", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Endymion\n");
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "created");
	vault.move("OnlyWorlds/Worlds/Hyperion", "OnlyWorlds/Worlds/Endymion");
	(app as unknown as { realRenames: boolean }).realRenames = true;
	assert.equal(await writeWorldBasesFile(app, "Endymion"), "rewritten");
	assert.deepEqual(basesUnder(vault, "OnlyWorlds/Worlds/Endymion"), [NEW_BASE]);
	assert.equal(vault.contentAt(NEW_BASE), endymionText());
});

test("a changed base with the plugin's marker anywhere under the world: Download keeps it and writes no second", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Endymion\n");
	await writeWorldBasesFile(app, "Hyperion");
	editBase(vault);
	vault.move("OnlyWorlds/Worlds/Hyperion", "OnlyWorlds/Worlds/Endymion");
	assert.equal(await writeWorldBasesFile(app, "Endymion"), "kept");
	assert.deepEqual(basesUnder(vault, "OnlyWorlds/Worlds/Endymion"), ["OnlyWorlds/Worlds/Endymion/Hyperion.base"]);
});

test("Write Bases file after a rename rebuilds the world's base in place of the old one: one base, the user's copy beside it", async () => {
	const { app, vault } = makeApp();
	const plugin = makePlugin();
	await download(app, plugin);
	const edited = editBase(vault);
	await renameHyperion(app, plugin);
	(app.workspace as unknown as { getActiveFile: () => unknown }).getActiveFile = () =>
		vault.files.get("OnlyWorlds/Worlds/Endymion/World.md")!.file;
	await new WriteBasesFileCommand(app).execute();
	assert.deepEqual(basesUnder(vault, "OnlyWorlds/Worlds/Endymion"), [
		"OnlyWorlds/Worlds/Endymion/Endymion (your copy).base",
		NEW_BASE,
	]);
	assert.equal(vault.contentAt(NEW_BASE), endymionText());
	assert.equal(vault.contentAt("OnlyWorlds/Worlds/Endymion/Endymion (your copy).base"), edited.split("\n").slice(1).join("\n"));
});
