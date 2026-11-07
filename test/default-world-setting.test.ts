/**
 * The primary world comes from the settings pane, not from a note (ruled 2026-11-03). Before 3.18 the settings
 * tab saved a "Default world" that nothing read; the code read `OnlyWorlds/Settings.md`. Now the setting is
 * the only source, and an old note left in the vault changes nothing.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { WorldService } from "../Scripts/WorldService";

const noteNamingZed = "# OnlyWorlds Plugin Settings\n\n- **Primary World Name:** Zed\n";

async function vault() {
	const { app, vault } = makeApp();
	await vault.seed("OnlyWorlds/Worlds/Alpha/World.md", "# World\n");
	await vault.seed("OnlyWorlds/Worlds/Barovia/World.md", "# World\n");
	await vault.seed("OnlyWorlds/Worlds/Zed/World.md", "# World\n");
	return { app, vault };
}

// Each test sets the provider itself; node --test gives every file its own process, so nothing leaks across files.

test("the setting names the primary world, as the old note's line did", async () => {
	const { app } = await vault();
	WorldService.defaultWorldProvider = () => "Barovia";
	assert.equal(await new WorldService(app).getWorldName(), "Barovia");
});

test("an empty setting falls to the top folder; a setting naming a folder that is not there does too", async () => {
	const { app } = await vault();
	WorldService.defaultWorldProvider = () => "";
	assert.equal(await new WorldService(app).getWorldName(), "Alpha");
	WorldService.defaultWorldProvider = () => "Nowhere";
	assert.equal(await new WorldService(app).getWorldName(), "Alpha");
	WorldService.defaultWorldProvider = null;
	assert.equal(await new WorldService(app).getWorldName(), "Alpha", "no provider at all (a test host): the top folder");
});

test("★ the old note is not read any more: it names Zed and the setting says Barovia, Barovia wins; with no setting the note is ignored", async () => {
	const { app, vault: v } = await vault();
	await v.seed("OnlyWorlds/Settings.md", noteNamingZed);
	WorldService.defaultWorldProvider = () => "Barovia";
	assert.equal(await new WorldService(app).getWorldName(), "Barovia");
	WorldService.defaultWorldProvider = () => "";
	assert.equal(await new WorldService(app).getWorldName(), "Alpha", "the note's Zed does not come back");
});

test("surrounding spaces in the setting do not defeat it", async () => {
	const { app } = await vault();
	WorldService.defaultWorldProvider = () => "  Barovia  ";
	assert.equal(await new WorldService(app).getWorldName(), "Barovia");
});
