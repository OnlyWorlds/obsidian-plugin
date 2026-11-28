/**
 * Export as OnlyWorlds folder names each element's file from its id (folder spec §3.2). An id that cannot be part of
 * one plain file name is left out and named, and every file an export writes stays inside the export folder.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeApp } from "./support/obsidian-mock";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import { escapesFolder, isPlainFileId, worldFolderName } from "../vault/folder-format";

const W = "OnlyWorlds/Worlds/W";
const GOOD = "019e0000-0000-7000-8000-0000000000a1";
const note = (name: string, id: string) => `---\nname: ${name}\nid: ${JSON.stringify(id)}\n---\n\n### Description\n\nx\n`;

const filesUnder = (root: string, at = root): string[] =>
	fs.readdirSync(at, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? filesUnder(root, path.join(at, e.name)) : [path.relative(root, path.join(at, e.name)).replace(/\\/g, "/")]);

async function exportOut(notes: Record<string, string>) {
	const { app, vault } = makeApp();
	await vault.seed(`${W}/World.md`, "# World Overview: W\n");
	for (const [p, t] of Object.entries(notes)) await vault.seed(`${W}/Elements/Character/${p}.md`, t);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ow-exp-"));
	const dest = path.join(root, "a", "b", "c");
	fs.mkdirSync(dest, { recursive: true });
	const cmd = new ExportFolderCommand(app) as any;
	const real = cmd.planFiles.bind(cmd);
	let failed: { path: string; reason: string }[] = [];
	cmd.planFiles = async (...args: unknown[]) => {
		const plan = await real(...args);
		failed = plan?.failed ?? [];
		return plan;
	};
	await cmd.exportWorld("W", { kind: "external", dir: dest });
	const written = filesUnder(root);
	fs.rmSync(root, { recursive: true, force: true });
	return { written, failed };
}

test("★ an id with path characters is left out and named; nothing is written outside the export folder", async () => {
	const bad: Record<string, string> = {
		"名": note("名", "../../../../escaped"), // no slug: the file would be named by the whole id
		Bob: note("Bob", "../../../../../x"), // named: the id's tail goes into the name
		Back: note("Back", "..\\..\\..\\..\\y"),
		Dots: note("名二", ".."),
		Ctl: note("Ctl", "a\u0001b"),
		Good: note("Good", GOOD),
	};
	const r = await exportOut(bad);
	assert.deepEqual(r.written.filter((f) => !/^a\/b\/c\/w-[^/]+\/(world\.json|elements\/character\/good--000000a1\.json)$/.test(f)), [], JSON.stringify(r.written));
	assert.equal(r.written.length, 2, JSON.stringify(r.written));
	assert.equal(r.failed.length, 5, JSON.stringify(r.failed));
	assert.ok(r.failed.every((f) => /cannot be part of a file name/.test(f.reason)), JSON.stringify(r.failed));
});

test("an id that is no UUID and is one plain name is still exported", async () => {
	const r = await exportOut({ List: note("List", "checklist-7") });
	assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
	assert.ok(r.written.some((f) => f.endsWith("elements/character/list--cklist7.json") || /elements\/character\/list--[^/]+\.json$/.test(f)), JSON.stringify(r.written));
});

test("isPlainFileId and escapesFolder", () => {
	for (const ok of [GOOD, "checklist-7", "a.b", "..a", "urn:uuid:1"]) assert.equal(isPlainFileId(ok), true, ok);
	for (const no of ["", ".", "..", "a/b", "a\\b", "a\nb", "a\u007fb"]) assert.equal(isPlainFileId(no), false, JSON.stringify(no));
	for (const ok of ["world.json", "elements/character/a--b.json", "records/x/.hidden", "records/..keep"]) assert.equal(escapesFolder(ok), false, ok);
	for (const no of ["../x.json", "elements/character/../../x", "a\\..\\b", "/etc/x", "C:/x", "a//b", "./a"]) assert.equal(escapesFolder(no), true, no);
});

test("★ a world id never climbs out through the export folder's name", () => {
	assert.equal(worldFolderName("W", "0695db52-5433-7332-8000-db7fe10da375"), "w-0695db52");
	for (const id of ["../../..", "..\\..\\abc", "/etc/passwd"]) assert.doesNotMatch(worldFolderName("W", id), /[/\\]|\.\./, id);
});
