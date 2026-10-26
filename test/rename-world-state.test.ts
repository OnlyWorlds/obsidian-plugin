/**
 * Round C, item 12: Rename World left the old folder's name in the once-only
 * Notice list (basesKeptNoticed). The old name is cleared. The type folders
 * carry no count: an old `Character (4)` moves with the
 * world as it is, and the next Download renames it.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp } from "./support/obsidian-mock";
import { RenameWorldCommand } from "../Commands/RenameWorldCommand";
import { DEFAULT_SETTINGS } from "../settings/settings";

const note = (id: string, name: string) => `---\nname: ${name}\nid: ${id}\n---\n\n### Description\n\n${name}.\n`;

test("★ Rename World clears the old name from the once-only Notice list and leaves the type folders' names alone (no count)", async () => {
	const { app, vault } = makeApp();
	(app as unknown as { realRenames: boolean }).realRenames = true;
	await vault.seed("OnlyWorlds/Worlds/Old/World.md", "- **Name:** Old\n");
	await vault.seed("OnlyWorlds/Worlds/Old/Elements/Character (4)/Ireena.md", note("0199c000-0000-7000-8000-0000000000c1", "Ireena"));
	await vault.seed("OnlyWorlds/Worlds/Old/Elements/Character (4)/Kolyan.md", note("0199c000-0000-7000-8000-0000000000c2", "Kolyan"));
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, basesKeptNoticed: ["Old", "Other"] },
		saveSettings: async () => {},
	};
	await new RenameWorldCommand(app, { version: "t" }, plugin as never).renameWorldFolder("Old", "New");
	await new Promise((r) => setTimeout(r, 400)); // long enough for the old debounced recount, which is gone
	assert.deepEqual(plugin.settings.basesKeptNoticed, ["Other"]);
	const paths = [...vault.files.keys()].filter((p) => p.endsWith("/Ireena.md"));
	// The counted folder moves with the world as it is; the next Download renames it to `Character`.
	assert.deepEqual(paths, ["OnlyWorlds/Worlds/New/Elements/Character (4)/Ireena.md"]);
});

test("Rename World moves the renames auto-sync left for Save Element to the new folder name (Kael's fixes read, low 5)", async () => {
	const { app, vault } = makeApp();
	(app as unknown as { realRenames: boolean }).realRenames = true;
	await vault.seed("OnlyWorlds/Worlds/Old/World.md", "- **Name:** Old\n");
	const plugin = {
		settings: { ...DEFAULT_SETTINGS, pendingRenames: { Old: ["0199c000-0000-7000-8000-0000000000c1"], Other: ["x"] } },
		saveSettings: async () => {},
	};
	await new RenameWorldCommand(app, { version: "t" }, plugin as never).renameWorldFolder("Old", "New");
	assert.deepEqual(plugin.settings.pendingRenames, { Other: ["x"], New: ["0199c000-0000-7000-8000-0000000000c1"] });
});
