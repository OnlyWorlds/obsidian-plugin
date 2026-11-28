/**
 * Folder format 0.3.25: a file in which an object or array sits more than 200 levels deep (objects and
 * arrays both count, the top object at 1) is not read. Import names it as failed and reads the rest.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "obsidian";
import { makeApp, __modals, __notices } from "./support/obsidian-mock";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { textTooDeep } from "../vault/folder-format";

const WID = "0199d000-0000-7000-8000-0000000000ee";
const AT = "0199d000-0000-7000-8000-0000000000c1";
const OVER = "0199d000-0000-7000-8000-0000000000c2";

/** The text of an object whose `x_deep` makes its deepest array sit at `levels`, the top object at 1. */
const nested = (head: Record<string, unknown>, levels: number): string =>
	JSON.stringify(head).slice(0, -1) + `,"x_deep":${"[".repeat(levels - 1)}${"]".repeat(levels - 1)}}`;

type Report = { created: string[]; failed: { path: string; reason: string }[] };

async function run(world: string, files: Record<string, string>): Promise<Report | undefined> {
	const { app, vault } = makeApp();
	await vault.seed("in/b/world.json", world);
	for (const [rel, text] of Object.entries(files)) await vault.seed(`in/b/${rel}`, text);
	__modals.length = 0;
	await (new ImportFolderCommand(app as App) as unknown as { importFolder(d: string): Promise<void> }).importFolder("in/b");
	return (__modals.find((m) => m.constructor.name === "ImportReportModal") as unknown as { result: Report } | undefined)?.result;
}

test("textTooDeep: 200 is read, 201 is not; brackets in a string and after an escaped quote do not count", () => {
	assert.equal(textTooDeep(nested({ a: 1 }, 200)), false);
	assert.equal(textTooDeep(nested({ a: 1 }, 201)), true);
	assert.equal(textTooDeep(JSON.stringify({ a: '"' + "[".repeat(500) })), false);
	assert.equal(textTooDeep("{".repeat(100) + "[".repeat(101)), true);
});

test("★ Import folder: an element file past 200 levels is not read and is named; the file at 200 is read", async () => {
	const r = await run(JSON.stringify({ id: WID, name: "Deep" }), {
		"elements/character/at.json": nested({ id: AT, type: "character", name: "At" }, 200),
		"elements/character/over.json": nested({ id: OVER, type: "character", name: "Over" }, 201),
	});
	assert.equal(r?.created.length, 1, JSON.stringify(r));
	assert.deepEqual(r?.failed.map((f) => f.path), ["in/b/elements/character/over.json"]);
	assert.match(r!.failed[0].reason, /more than 200 levels/);
});

test("★ Import folder: a world.json past 200 levels imports nothing and says why", async () => {
	__notices.length = 0;
	const r = await run(nested({ id: WID, name: "Deep" }, 201), {
		"elements/character/at.json": JSON.stringify({ id: AT, type: "character", name: "At" }),
	});
	assert.equal(r, undefined);
	assert.match(JSON.stringify(__notices), /more than 200 levels/);
});
