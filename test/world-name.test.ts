/**
 * A world's name becomes a folder under OnlyWorlds/Worlds/ only as one safe
 * path segment (Kael's review 3.7). The name comes from a server, a folder's
 * world.json, or a join link a stranger made: `../x` must never climb out.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeApp, setRequestUrl } from "./support/obsidian-mock";
import { safeWorldFolderName } from "../vault/world-name";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { DownloadWorldCommand } from "../Commands/DownloadWorldCommand";

const HOSTILE = ["../x", "a/b", "C:x", "..", ".", "a\\b", "  .hidden  ", "con", "x*?<>|\"y", "../../../etc", "name. "];

test("safeWorldFolderName: one segment, no separators or Windows-reserved characters, never . or .., trimmed", () => {
	assert.equal(safeWorldFolderName("../x"), "-x");
	assert.equal(safeWorldFolderName("a/b"), "a-b");
	assert.equal(safeWorldFolderName("C:x"), "C-x");
	assert.equal(safeWorldFolderName(".."), "Untitled world");
	assert.equal(safeWorldFolderName("Barovia"), "Barovia");
	assert.equal(safeWorldFolderName("  Aria's Storm Coast  "), "Aria's Storm Coast");
	for (const raw of HOSTILE) {
		const s = safeWorldFolderName(raw);
		assert.ok(!/[\\/:*?"<>|\x00-\x1f]/.test(s), `${raw} -> ${s}`);
		assert.ok(s !== "." && s !== ".." && !s.startsWith("."), `${raw} -> ${s}`);
		assert.equal(s, s.trim(), raw);
		assert.ok(!/[. ]$/.test(s), `${raw} -> ${s}: trailing dot or space`);
		assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s), `${raw} -> ${s}: reserved`);
		assert.ok(s.length > 0);
	}
});

test("a folder whose world.json names the world '../x' imports inside OnlyWorlds/Worlds/", async () => {
	const { app, vault } = makeApp();
	const id = "0199b000-0000-7000-8000-0000000000aa";
	await vault.seed("in/w/world.json", JSON.stringify({ id, name: "../x" }));
	await vault.seed("in/w/elements/character/a.json", JSON.stringify({ id: "0199b000-0000-7000-8000-0000000000c1", name: "A" }));
	await (new ImportFolderCommand(app) as unknown as { importFolder(d: string): Promise<void> }).importFolder("in/w");
	const written = [...vault.files.keys()].filter((p) => !p.startsWith("in/"));
	assert.ok(written.length > 0);
	for (const p of written) assert.ok(p.startsWith("OnlyWorlds/Worlds/-x/"), p);
});

test("a server world named 'a/b' (or '..') downloads inside OnlyWorlds/Worlds/ as one folder", async () => {
	for (const [name, folder] of [["a/b", "a-b"], ["..", "Untitled world"]]) {
		const { app, vault } = makeApp();
		setRequestUrl((r) => {
			const path = new URL(r.url).pathname.replace(/^\/api\/v2/, "").replace(/\/$/, "");
			if (path === "/world") return { status: 200, json: { id: "0199b000-0000-7000-8000-0000000000aa", name, description: "" } };
			if (path === "/changes") return { status: 200, json: { cursor: "c", has_more: false, head: 1, changes: [
				{ op: "upsert", type: "character", id: "0199b000-0000-7000-8000-0000000000c1", change_seq: 1, updated_at: "x", element: { id: "0199b000-0000-7000-8000-0000000000c1", name: "A" } },
			] } };
			return { status: 404, json: {} };
		});
		const plugin = { settings: { syncCursors: {} }, saveSettings: async () => {} };
		const got = await new DownloadWorldCommand(app, { version: "t" }, plugin as never).downloadWithKey("ow_r_k", "");
		assert.equal(got, folder);
		for (const p of [...vault.files.keys()].filter((p) => p.startsWith("OnlyWorlds/Worlds/"))) {
			assert.ok(p.startsWith(`OnlyWorlds/Worlds/${folder}/`), `${name}: ${p}`);
		}
	}
});
