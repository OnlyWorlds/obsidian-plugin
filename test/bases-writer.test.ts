/**
 * Writing a world's Bases file into the vault (OW Infra #188): Download World
 * and Create World write `<world>.base` beside World.md (behind a setting,
 * on by default), the Write Bases file command writes one any time, and the
 * plugin overwrites only a file it wrote and nobody changed since.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl, __notices } from "./support/obsidian-mock";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";
import { CreateWorldCommand } from "../Commands/CreateWorldCommand";
import { WriteBasesFileCommand } from "../Commands/WriteBasesFileCommand";
import { basesFilePath, pluginBasesSchema, writeWorldBasesFile } from "../vault/bases-writer";
import { buildBasesFile, mayOverwriteBasesFile } from "../vault/bases-file";
import { DEFAULT_SETTINGS } from "../settings/settings";

const WORLD_ID = "0199b000-0000-7000-8000-0000000000aa";
const CHAR_ID = "0199b000-0000-7000-8000-0000000000c1";
const BASE = "OnlyWorlds/Worlds/Hyperion/Hyperion.base";
const USERS_OWN = "views:\n  - type: table\n    name: My own\n";

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
						{ op: "upsert", type: "character", id: CHAR_ID, change_seq: 1, updated_at: "x", element: { id: CHAR_ID, name: "Kassad", supertype: "Soldier" } },
					],
				},
			};
		return { status: 404, json: {} };
	});
}

function plugin(writeBasesFile: boolean) {
	return { settings: { ...DEFAULT_SETTINGS, syncCursors: {}, writeBasesFile }, saveSettings: async () => {} };
}

async function download(app: ReturnType<typeof makeApp>["app"], on = true): Promise<string | null> {
	serveHyperion();
	return new DownloadWorldCommand(app, { version: "t" }, plugin(on) as never).downloadWithKey("ow_r_k", "");
}

function content(vault: ReturnType<typeof makeApp>["vault"], p: string): string | undefined {
	return vault.files.get(p)?.content;
}

test("the setting defaults to on", () => {
	assert.equal(DEFAULT_SETTINGS.writeBasesFile, true);
});

test("Download World writes <world>.base beside World.md: the plugin's text, all 22 types", async () => {
	const { app, vault } = makeApp();
	assert.equal(await download(app), "Hyperion");
	assert.equal(basesFilePath("Hyperion"), BASE);
	const text = content(vault, BASE);
	assert.ok(text, "no Bases file");
	assert.ok(vault.files.has("OnlyWorlds/Worlds/Hyperion/World.md"));
	assert.equal(text, buildBasesFile({ worldName: "Hyperion", worldFolderPath: "OnlyWorlds/Worlds/Hyperion", schema: pluginBasesSchema() }));
	assert.equal(Object.keys(pluginBasesSchema()).length, 22);
	assert.equal((text.match(/^  - type: table$/gm) ?? []).length, 23, "All elements + one table per type");
	assert.equal((text.match(/^  - type: cards$/gm) ?? []).length, 22);
	assert.equal(mayOverwriteBasesFile(text), true);
});

test("with the setting off, Download World writes no Bases file", async () => {
	const { app, vault } = makeApp();
	assert.equal(await download(app, false), "Hyperion");
	assert.equal(vault.files.has(BASE), false);
});

test("a user's own .base at that path (no marker) is never overwritten, by Download World or the writer", async () => {
	const { app, vault } = makeApp();
	await download(app);
	await vault.modify(vault.files.get(BASE)!.file, USERS_OWN); // the user replaces it with their own
	assert.equal(await download(app), "Hyperion");
	assert.equal(content(vault, BASE), USERS_OWN);
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "kept");
	assert.equal(content(vault, BASE), USERS_OWN);
});

test("the plugin's own file, unchanged since, is rewritten to the current text", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	// An older build's file: only one type then.
	const older = buildBasesFile({ worldName: "Hyperion", worldFolderPath: "OnlyWorlds/Worlds/Hyperion", schema: { Character: { name: { type: "text" } } } });
	await vault.seed(BASE, older);
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "rewritten");
	const now = content(vault, BASE);
	assert.notEqual(now, older);
	assert.equal(now, buildBasesFile({ worldName: "Hyperion", worldFolderPath: "OnlyWorlds/Worlds/Hyperion", schema: pluginBasesSchema() }));
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "unchanged");
});

test("the plugin's file, once edited (marker kept, a view renamed), is the user's: kept", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "created");
	const edited = content(vault, BASE)!.replace('name: "Characters"', 'name: "People"');
	await vault.modify(vault.files.get(BASE)!.file, edited);
	assert.equal(await writeWorldBasesFile(app, "Hyperion"), "kept");
	assert.equal(content(vault, BASE), edited);
});

test("Download World again rewrites the plugin's own file and keeps no second copy", async () => {
	const { app, vault } = makeApp();
	await download(app);
	const first = content(vault, BASE);
	await download(app);
	assert.equal(content(vault, BASE), first);
	assert.deepEqual([...vault.files.keys()].filter((p) => p.endsWith(".base")), [BASE]);
});

test("the world's Name line names it in the header; the folder name is the file name", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Tess-s World/World.md", "- **Name:** Tess/s World\n");
	assert.equal(await writeWorldBasesFile(app, "Tess-s World"), "created");
	const text = content(vault, "OnlyWorlds/Worlds/Tess-s World/Tess-s World.base")!;
	assert.match(text, /^# World: Tess\/s World$/m);
	assert.match(text, /file\.inFolder\("OnlyWorlds\/Worlds\/Tess-s World\/Elements"\)/);
});

test("Create World (local) writes the Bases file, and not when the setting is off", async () => {
	for (const on of [true, false]) {
		const { app, vault } = makeApp();
		const cmd = new CreateWorldCommand(app, { version: "test" } as never, undefined, () => null, () => on);
		await cmd.createLocalWorldFiles("Hyperion", { api_key: "local" });
		assert.ok(vault.files.has("OnlyWorlds/Worlds/Hyperion/World.md"));
		assert.equal(vault.files.has(BASE), on, `setting ${on}`);
	}
});

test("Write Bases file: the active note's world; a kept file is named in a Notice", async () => {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Hyperion/World.md", "- **Name:** Hyperion\n");
	await vault.seed("OnlyWorlds/Worlds/Other/World.md", "- **Name:** Other\n");
	await vault.seed("OnlyWorlds/Worlds/Hyperion/Elements/Character/Kassad.md", "---\nname: Kassad\n---\n");
	(app.workspace as unknown as { getActiveFile: () => unknown }).getActiveFile = () =>
		vault.files.get("OnlyWorlds/Worlds/Hyperion/Elements/Character/Kassad.md")!.file;
	__notices.length = 0;
	await new WriteBasesFileCommand(app).execute();
	assert.ok(vault.files.has(BASE));
	assert.equal(vault.files.has("OnlyWorlds/Worlds/Other/Other.base"), false);
	assert.ok(__notices.some((n) => n.startsWith(`Bases file written: ${BASE}`)), __notices.join(" / "));

	await vault.modify(vault.files.get(BASE)!.file, USERS_OWN);
	__notices.length = 0;
	await new WriteBasesFileCommand(app).execute();
	assert.equal(content(vault, BASE), USERS_OWN);
	assert.ok(__notices.some((n) => n.includes("left alone")), __notices.join(" / "));
});
