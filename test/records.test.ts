/**
 * `records/` through the folder import and export (OW Obsidian #577; folder
 * format spec §4.5 rules 6 and 11, §4.7 OW-8), against the REAL import and
 * export commands through the in-memory vault (test/support/obsidian-mock.ts).
 *
 * The law: a tool that rewrites a folder copies `records/` through untouched,
 * byte for byte, `RECORDS.json` whole; an export leaves out, whole, every
 * producer directory its manifest marks `"private": true`, unless asked; a
 * manifest that cannot be read leaves nothing out by guess.
 *
 * The conformance cases are schema-dist's OW-8 set (serial 52,
 * `fixtures/owworld/`), vendored byte for byte under test/fixtures/owworld/
 * with the set's verdicts.json: the seven OW-8 zips and pass-good (the base
 * world they are cut from). Each is checked against its sha256 in the
 * verdicts first, so a copy that drifted fails loudly.
 */
import "./support/obsidian-shim"; // MUST stay first: routes `obsidian` to the mock
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "obsidian";
import { readWorldFile } from "@onlyworlds/sdk";
import { makeApp, __modals, type MockVault } from "./support/obsidian-mock";
import { ImportFolderCommand } from "../Commands/ImportFolderCommand";
import { ExportFolderCommand } from "../Commands/ExportFolderCommand";
import {
	INCLUDE_EVERY_RECORD,
	INCLUDE_PRIVATE_RECORDS,
	planRecords,
	readRecordsManifest,
	recordsOption,
	recordsReportLines,
	type RecordFile,
} from "../vault/records";

const WID = "0199b000-0000-7000-8000-0000000000aa";
const CHAR_ID = "0199b000-0000-7000-8000-0000000000c1";
const enc = (s: string) => new TextEncoder().encode(s);

/** A record file with a BOM, CRLF and a NUL: any re-encoding changes its bytes. */
const LEDGER = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x00, 0xff, 0x62, 0x0d, 0x0a]);
/** RECORDS.json as a producer wrote it: odd spacing and key order, CRLF, no final newline. */
const MANIFEST_TWO = enc('[ {"producer":"lab", "format":"ledger", "version":"2", "deltas":true},\r\n  {"private": true, "producer": "Fold", "format": "spine", "version": "1", "deltas": false} ]');

/** A world folder in the vault at `dir`: world.json, one Character, and the given record files. */
async function seedWorld(vault: MockVault, dir: string, records: Record<string, Uint8Array>): Promise<void> {
	await vault.seed(`${dir}/world.json`, JSON.stringify({ id: WID, name: "Barovia" }, null, 2) + "\n");
	await vault.seed(`${dir}/elements/character/ireena.json`, JSON.stringify({ id: CHAR_ID, type: "character", name: "Ireena" }, null, 2) + "\n");
	for (const [rel, bytes] of Object.entries(records)) await vault.seedBinary(`${dir}/${rel}`, bytes);
}

const TWO_PRODUCERS: Record<string, Uint8Array> = {
	"records/RECORDS.json": MANIFEST_TWO,
	"records/lab/ledger.bin": LEDGER,
	"records/lab/.cursor": enc("42\r\n"),
	"records/lab/world.json": enc('{"not":"a world"}'),
	"records/fold/spine.jsonl": enc('{"at":1}\n{"at":2}\n'),
	"records/fold/.head": enc("2"),
};

async function importDir(app: App, dir: string): Promise<void> {
	const cmd = new ImportFolderCommand(app) as unknown as { importFolder(dir: string): Promise<void> };
	await cmd.importFolder(dir);
}

/** Every file on the vault's disk under `prefix/` (dot-files included), path relative to it -> bytes. */
async function filesUnder(vault: MockVault, prefix: string): Promise<Map<string, Uint8Array>> {
	const out = new Map<string, Uint8Array>();
	for (const p of [...vault.files.keys(), ...vault.dotfiles.keys()]) {
		if (!p.startsWith(prefix + "/")) continue;
		out.set(p.slice(prefix.length + 1), (await vault.bytesAt(p)) as Uint8Array);
	}
	return out;
}

/** Export `world` into the vault; the export's files (rel -> bytes) and its report's records lines. */
async function exportWorld(app: App, vault: MockVault, world: string, includePrivateRecords?: boolean) {
	for (const p of [...vault.files.keys()]) if (p.startsWith("OW-folder-export/")) vault.files.delete(p);
	for (const p of [...vault.dotfiles.keys()]) if (p.startsWith("OW-folder-export/")) vault.dotfiles.delete(p);
	for (const p of [...vault.folders.keys()]) if (p.startsWith("OW-folder-export")) vault.folders.delete(p);
	__modals.length = 0;
	const cmd = new ExportFolderCommand(app) as unknown as {
		exportWorld(world: string, dest: { kind: "vault" }, opts?: { includePrivateRecords?: boolean }): Promise<void>;
	};
	await cmd.exportWorld(world, { kind: "vault" }, includePrivateRecords === undefined ? undefined : { includePrivateRecords });
	const folder = [...vault.folders.keys()].find((p) => /^OW-folder-export\/[^/]+$/.test(p));
	assert.ok(folder, "no export folder");
	const report = __modals.find((m) => m.constructor.name === "ExportReportModal") as unknown as { recordsLines: string[] } | undefined;
	assert.ok(report, "no export report");
	return { files: await filesUnder(vault, folder), lines: report.recordsLines };
}

function recordsOf(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
	return new Map([...files].filter(([p]) => p.startsWith("records/")).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function sameBytes(a: Map<string, Uint8Array>, b: Map<string, Uint8Array>): boolean {
	if (a.size !== b.size) return false;
	for (const [p, bytes] of a) {
		const other = b.get(p);
		if (!other || Buffer.compare(Buffer.from(bytes), Buffer.from(other)) !== 0) return false;
	}
	return true;
}

function assertSameBytes(got: Map<string, Uint8Array>, want: Map<string, Uint8Array>, what: string): void {
	assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort(), `${what}: the files differ`);
	for (const [p, bytes] of want) assert.ok(Buffer.compare(Buffer.from(got.get(p) as Uint8Array), Buffer.from(bytes)) === 0, `${what}: ${p} changed`);
}

// --- the manifest, pure ------------------------------------------------------------

test("RECORDS.json: absent, unreadable (not JSON, not an array, an entry not an object, an entry with no producer name), or the private producers", () => {
	assert.deepEqual(readRecordsManifest(null), { kind: "absent" });
	assert.equal(readRecordsManifest(enc("{")).kind, "unreadable");
	assert.equal(readRecordsManifest(enc('{"producer":"lab"}')).kind, "unreadable");
	assert.equal(readRecordsManifest(enc("[1]")).kind, "unreadable");
	assert.equal(readRecordsManifest(enc('[{"private":true}]')).kind, "unreadable");
	assert.equal(readRecordsManifest(enc('[{"producer":"lab"},{"format":"ledger"}]')).kind, "unreadable", "a public entry with no producer name (Amendment A)");
	assert.equal(readRecordsManifest(enc('[{"producer":7}]')).kind, "unreadable", "a producer name that is not a string");
	assert.equal(readRecordsManifest(new Uint8Array([0x5b, 0xff, 0x5d])).kind, "unreadable", "not UTF-8");
	assert.deepEqual(readRecordsManifest(enc('[{"producer":"lab"},{"producer":"fold","private":true},{"producer":"x","private":"true"}]')), {
		kind: "readable",
		privateProducers: ["fold"],
	});
});

test("planRecords: a private producer is matched to its directory after OW-18's fold, left out whole; `\"true\"` is not private; asked, everything travels", () => {
	const files: RecordFile[] = [
		{ rel: "records/RECORDS.json", data: enc('[{"producer":"FOLD","private":true},{"producer":"lab","private":"true"}]') },
		{ rel: "records/fold/.head", data: enc("1") },
		{ rel: "records/fold/deep/spine.jsonl", data: enc("{}") },
		{ rel: "records/lab/ledger.bin", data: LEDGER },
	];
	const plan = planRecords(files, false);
	assert.deepEqual(plan.files.map((f) => f.rel), ["records/RECORDS.json", "records/lab/ledger.bin"]);
	assert.deepEqual(plan.leftOut, ["fold"]);
	assert.equal(plan.files[0].data, files[0].data, "the manifest is passed through as the same bytes");
	assert.deepEqual(planRecords(files, true).files.map((f) => f.rel), files.map((f) => f.rel));
	assert.deepEqual(recordsOption(files), { kind: "private", producers: ["fold"] });
});

test("recordsOption: the switch is asked for private producers the folder holds, for an unreadable manifest beside producer directories, and for nothing else (Amendment A)", () => {
	const lab = { rel: "records/lab/ledger.bin", data: LEDGER };
	assert.deepEqual(recordsOption([{ rel: "records/RECORDS.json", data: enc("{") }, lab]), { kind: "unreadable" });
	assert.equal(recordsOption([{ rel: "records/RECORDS.json", data: enc("{") }]), null, "an unreadable manifest with no producer directory: nothing to ask");
	assert.equal(recordsOption([lab]), null, "no manifest: nothing can be private");
	assert.equal(recordsOption([{ rel: "records/RECORDS.json", data: enc('[{"producer":"fold","private":true}]') }, lab]), null, "a private producer the folder does not hold");
	assert.equal(INCLUDE_EVERY_RECORD, "Include every record (the records list could not be read)");
	assert.equal(INCLUDE_PRIVATE_RECORDS, "Include private records");
});

test("the report's records lines: carried, left out, no manifest, unreadable manifest off and on", () => {
	assert.deepEqual(recordsReportLines(null), []);
	const left = recordsReportLines(planRecords([{ rel: "records/RECORDS.json", data: MANIFEST_TWO }, { rel: "records/fold/a", data: enc("x") }], false));
	assert.match(left[1], /^Private records left out: fold\. RECORDS\.json still lists them; turn on Include private records to carry them\.$/);
	assert.match(recordsReportLines(planRecords([{ rel: "records/lab/a", data: enc("x") }], false))[1], /^records\/ has no RECORDS\.json, so every record went out: nothing can be private without one\.$/);
	const unreadable = [{ rel: "records/RECORDS.json", data: enc("{") }, { rel: "records/lab/a", data: enc("x") }];
	assert.deepEqual(recordsReportLines(planRecords(unreadable, false)), [
		"1 record file carried in records/, byte for byte",
		"records/RECORDS.json could not be read, so no producer's records went out (lab) and RECORDS.json went out unchanged; turn on Include every record (the records list could not be read) to carry them.",
	]);
	assert.deepEqual(recordsReportLines(planRecords(unreadable, true)), [
		"2 record files carried in records/, byte for byte",
		"records/RECORDS.json could not be read, and you asked for every record, so every record went out.",
	]);
});

// --- import and export through the commands ------------------------------------------

test("★ import of a folder with two producers, one private, keeps both in the world's records/, byte for byte, dot-files and a producer's world.json included", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault, "Drop/barovia", TWO_PRODUCERS);
	await importDir(app, "Drop/barovia");
	const held = await filesUnder(vault, "OnlyWorlds/Worlds/Barovia");
	const records = recordsOf(held);
	assertSameBytes(records, new Map(Object.entries(TWO_PRODUCERS)), "the vault's records");
	const report = __modals.find((m) => m.constructor.name === "ImportReportModal") as unknown as { result: { records: string } };
	assert.equal(report.result.records, "6 record files kept in records/, byte for byte");
});

test("★ export: asked, both producers go out byte for byte; by default the private one stays out whole and RECORDS.json goes out unchanged", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault, "Drop/barovia", TWO_PRODUCERS);
	await importDir(app, "Drop/barovia");

	const asked = await exportWorld(app, vault, "Barovia", true);
	assertSameBytes(recordsOf(asked.files), new Map(Object.entries(TWO_PRODUCERS)), "asked");
	assert.deepEqual(asked.lines, ["6 record files carried in records/, byte for byte"]);

	const plain = await exportWorld(app, vault, "Barovia");
	const want = new Map(Object.entries(TWO_PRODUCERS).filter(([p]) => !p.startsWith("records/fold/")));
	assertSameBytes(recordsOf(plain.files), want, "default");
	assert.deepEqual(plain.lines, [
		"4 record files carried in records/, byte for byte",
		"Private records left out: fold. RECORDS.json still lists them; turn on Include private records to carry them.",
	]);
	// the elements and world.json are the export's as before
	assert.ok(plain.files.has("world.json"));
	assert.ok([...plain.files.keys()].some((p) => p.startsWith("elements/character/")));
});

test("★ a records/ without a manifest travels whole, and the report says nothing can be private without one", async () => {
	const { app, vault } = makeApp();
	const records: Record<string, Uint8Array> = { "records/fold/.head": enc("2"), "records/lab/ledger.bin": LEDGER };
	await seedWorld(vault, "Drop/barovia", records);
	await importDir(app, "Drop/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	assertSameBytes(recordsOf(out.files), new Map(Object.entries(records)), "no manifest");
	assert.match(out.lines[out.lines.length - 1], /every record went out: nothing can be private without one\.$/);
});

test("★ an unreadable RECORDS.json (malformed JSON, not an array, an entry with no producer name): off, no producer directory goes out and RECORDS.json travels byte-exact; on, everything travels whole (Amendment A)", async () => {
	for (const [shape, manifest] of [
		["malformed JSON", enc('[{"producer":"fold","private":true}')],
		["not an array", enc('{"producer":"fold","private":true}')],
		["an entry with no producer name", enc('[{"producer":"lab"},{"private":true,"format":"spine"}]')],
	] as const) {
		const { app, vault } = makeApp();
		const records: Record<string, Uint8Array> = {
			"records/RECORDS.json": manifest,
			"records/fold/.head": enc("2"),
			"records/lab/ledger.bin": LEDGER,
		};
		await seedWorld(vault, "Drop/barovia", records);
		await importDir(app, "Drop/barovia");

		const off = await exportWorld(app, vault, "Barovia");
		assertSameBytes(recordsOf(off.files), new Map([["records/RECORDS.json", manifest]]), `${shape}, off`);
		assert.deepEqual(off.lines, [
			"1 record file carried in records/, byte for byte",
			"records/RECORDS.json could not be read, so no producer's records went out (fold, lab) and RECORDS.json went out unchanged; turn on Include every record (the records list could not be read) to carry them.",
		], shape);

		const on = await exportWorld(app, vault, "Barovia", true);
		assertSameBytes(recordsOf(on.files), new Map(Object.entries(records)), `${shape}, on`);
		assert.deepEqual(on.lines, [
			"3 record files carried in records/, byte for byte",
			"records/RECORDS.json could not be read, and you asked for every record, so every record went out.",
		], shape);
	}
});

test("a world without records exports none and says nothing about them", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault, "Drop/barovia", {});
	await importDir(app, "Drop/barovia");
	const out = await exportWorld(app, vault, "Barovia");
	assert.equal(recordsOf(out.files).size, 0);
	assert.deepEqual(out.lines, []);
});

test("a re-import keeps the records the vault holds, and a producer's world.json is never offered as a world to import", async () => {
	const { app, vault } = makeApp();
	await seedWorld(vault, "Drop/barovia", TWO_PRODUCERS);
	await importDir(app, "Drop/barovia");
	await vault.seedBinary("Drop/barovia/records/lab/new.bin", enc("later"));
	__modals.length = 0;
	await importDir(app, "Drop/barovia");
	const report = __modals.find((m) => m.constructor.name === "ImportReportModal") as unknown as { result: { records: string } };
	assert.match(report.result.records, /already in this world: the vault's copy is kept as it is/);
	assert.equal(await vault.bytesAt("OnlyWorlds/Worlds/Barovia/records/lab/new.bin"), undefined);
	const candidates = (new ImportFolderCommand(app) as unknown as { findWorldFolders(): string[] }).findWorldFolders();
	assert.deepEqual(candidates, ["Drop/barovia"]);
});

// --- the OW-8 conformance set ---------------------------------------------------------

const FIXTURES = join(__dirname, "..", "..", "test", "fixtures", "owworld");

interface Verdict {
	file: string;
	test: string;
	writer: "accept" | "refuse";
	source?: string;
	side?: string;
	sha256: string;
}

const VERDICTS = JSON.parse(readFileSync(join(FIXTURES, "verdicts.json"), "utf8")) as {
	fixtures: Verdict[];
	source: { top: string; files: Record<string, string> };
	sources: { private: { top: string; private: string[]; files: Record<string, string> } };
};

/** A vendored fixture, checked against the set's sha256, opened with the SDK's reader: its files by path. */
function openFixture(file: string): Map<string, Uint8Array> {
	const bytes = new Uint8Array(readFileSync(join(FIXTURES, file)));
	const v = VERDICTS.fixtures.find((f) => f.file === file);
	assert.ok(v, `${file} is not in verdicts.json`);
	assert.equal(createHash("sha256").update(bytes).digest("hex"), v.sha256, `${file} is not the set's copy`);
	return new Map(readWorldFile(bytes).files.map((f) => [f.path, f.data]));
}

/** Import a fixture's world into a fresh vault; its world folder's name there. */
async function importFixture(file: string): Promise<{ app: App; vault: MockVault; world: string }> {
	const { app, vault } = makeApp();
	for (const [path, data] of openFixture(file)) await vault.seedBinary(`Drop/w/${path}`, data);
	await importDir(app, "Drop/w");
	const world = [...vault.folders.keys()].map((p) => /^OnlyWorlds\/Worlds\/([^/]+)$/.exec(p)?.[1]).find((n) => n);
	assert.ok(world, `${file}: no world imported`);
	return { app, vault, world };
}

function sha(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

test("★ OW-8, the private case: import then export gives pass-OW-8-private-left-out's records by default and pass-OW-8-private-asked's when asked; never partial, never a rewritten manifest", async () => {
	const ow8 = VERDICTS.fixtures.filter((f) => f.test === "OW-8");
	assert.equal(ow8.length, 7, "the set's OW-8 cases");
	const { app, vault, world } = await importFixture("pass-OW-8-private-asked.owworld");
	const plain = recordsOf((await exportWorld(app, vault, world)).files);
	const asked = recordsOf((await exportWorld(app, vault, world, true)).files);

	// against the set's source hashes: asked is the source's records whole, default the same minus fold/
	const src = VERDICTS.sources.private.files;
	const srcRecords = Object.keys(src).filter((p) => p.startsWith("records/")).sort();
	assert.deepEqual([...asked.keys()], srcRecords);
	for (const [p, b] of asked) assert.equal(sha(b), src[p], `asked: ${p}`);
	assert.deepEqual([...plain.keys()], srcRecords.filter((p) => !p.startsWith("records/fold/")));
	for (const [p, b] of plain) assert.equal(sha(b), src[p], `default: ${p}`);

	// against each fixture of the private source: a pass fixture's records are ours on its side, a fail fixture's are neither
	for (const v of ow8.filter((f) => f.source === "private")) {
		const theirs = recordsOf(openFixture(v.file));
		if (v.writer === "accept") {
			assert.ok(sameBytes(v.side === "asked" ? asked : plain, theirs), `${v.file}: our ${v.side} export is not this file's records`);
		} else {
			assert.ok(!sameBytes(plain, theirs) && !sameBytes(asked, theirs), `${v.file}: the plugin wrote what the set refuses`);
		}
	}
});

test("★ OW-8, the base world: import then export carries pass-good's records byte for byte; fail-OW-8-records-missing, -reencoded and -producer-meta-dropped are never what it writes", async () => {
	const { app, vault, world } = await importFixture("pass-good.owworld");
	const ours = recordsOf((await exportWorld(app, vault, world)).files);
	const src = VERDICTS.source.files;
	const srcRecords = Object.keys(src).filter((p) => p.startsWith("records/")).sort();
	assert.deepEqual([...ours.keys()], srcRecords);
	for (const [p, b] of ours) assert.equal(sha(b), src[p], p);
	for (const v of VERDICTS.fixtures.filter((f) => f.test === "OW-8" && !f.source)) {
		assert.equal(v.writer, "refuse", v.file);
		assert.ok(!sameBytes(ours, recordsOf(openFixture(v.file))), `${v.file}: the plugin wrote what the set refuses`);
	}
});

test("OW-8, a private producer the manifest lists but the folder no longer holds: pass-OW-8-private-left-out round-trips unchanged", async () => {
	const { app, vault, world } = await importFixture("pass-OW-8-private-left-out.owworld");
	const theirs = recordsOf(openFixture("pass-OW-8-private-left-out.owworld"));
	assert.ok(sameBytes(recordsOf((await exportWorld(app, vault, world)).files), theirs));
	assert.ok(sameBytes(recordsOf((await exportWorld(app, vault, world, true)).files), theirs));
});
