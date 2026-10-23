/**
 * `records/` in a world folder — PURE logic, NO Obsidian imports (unit-tested
 * under `npm test`). OW Obsidian #577.
 *
 * The folder format (spec §4.5) keeps world data that is not elements under
 * `records/` at the world's root: one directory per producer, in the
 * producer's own format, and a manifest `records/RECORDS.json`, a JSON array
 * of entries. A tool that rewrites a folder copies `records/` through
 * untouched, byte-exact (rule 6), so the plugin never parses, re-encodes,
 * renames or reorders a record file: it moves bytes.
 *
 * The one thing it reads is the manifest, for the private clause (rule 11,
 * §4.7's OW-8): an export leaves out, whole, every producer directory whose
 * entry says `"private": true` (the boolean), unless the person asks for
 * them; `RECORDS.json` travels byte-exact either way, so a reader learns a
 * producer was left out rather than never there. An entry is matched to its
 * directory after OW-18's fold (NFC, then Unicode 15.1 simple case folding,
 * the SDK's table), so `Fold` names `records/fold/`. A manifest the plugin
 * cannot read leaves nothing out by guess: every record travels, and the
 * export's report says so. The reading mirrors the SDK's writeWorldFile
 * (4.66.0), which refuses where this export carries everything and says so.
 */
import { simpleCaseFold } from "@onlyworlds/sdk";

export const RECORDS_DIR = "records";
export const RECORDS_MANIFEST = "records/RECORDS.json";

/** One file of a world's records, its path relative to the world's folder (`records/...`). */
export interface RecordFile {
	rel: string;
	data: Uint8Array;
}

/** OW-18's fold: NFC, then simple case folding. */
export function foldName(name: string): string {
	return simpleCaseFold(name.normalize("NFC"));
}

/** True for a path inside a world's `records/` (relative to the world's folder). */
export function isRecordsPath(rel: string): boolean {
	return rel.startsWith(`${RECORDS_DIR}/`);
}

/**
 * The manifest as the private clause reads it:
 *   - `absent`: no `records/RECORDS.json`;
 *   - `unreadable`: not UTF-8 JSON, not an array of objects, or an entry
 *     marked private with no producer name: which records are private
 *     cannot be told, so none is left out;
 *   - `readable`: the producers whose entry says `"private": true`.
 */
export type ManifestReading =
	| { kind: "absent" }
	| { kind: "unreadable"; why: string }
	| { kind: "readable"; privateProducers: string[] };

export function readRecordsManifest(manifest: Uint8Array | null): ManifestReading {
	if (manifest === null) return { kind: "absent" };
	let doc: unknown;
	try {
		doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest));
	} catch {
		return { kind: "unreadable", why: "is not JSON" };
	}
	if (!Array.isArray(doc)) return { kind: "unreadable", why: "is not a JSON array of entries" };
	const privateProducers: string[] = [];
	for (const entry of doc) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return { kind: "unreadable", why: "holds an entry that is not an object" };
		}
		const { producer, private: isPrivate } = entry as { producer?: unknown; private?: unknown };
		if (isPrivate !== true) continue;
		if (typeof producer !== "string" || producer === "") {
			return { kind: "unreadable", why: "marks an entry private without a producer name" };
		}
		privateProducers.push(producer);
	}
	return { kind: "readable", privateProducers };
}

/** What an export of a world's records writes, and what its report says. */
export interface RecordsPlan {
	/** The files that travel, byte for byte as held, in the order given. */
	files: RecordFile[];
	/** The producer directories left out as private, as the folder names them (sorted). */
	leftOut: string[];
	/** The manifest as read: `unreadable` and `absent` carry every record. */
	manifest: ManifestReading["kind"];
}

/**
 * Which of a world's record files an export writes (rule 6 and rule 11). A
 * file inside a private producer's directory (`records/<producer>/...`) is
 * left out unless `includePrivate`; every other file, `RECORDS.json` among
 * them, travels as it is. With no readable manifest, everything travels.
 */
export function planRecords(files: RecordFile[], includePrivate: boolean): RecordsPlan {
	const manifestFile = files.find((f) => f.rel === RECORDS_MANIFEST) ?? null;
	const reading = readRecordsManifest(manifestFile ? manifestFile.data : null);
	if (includePrivate || reading.kind !== "readable" || reading.privateProducers.length === 0) {
		return { files: [...files], leftOut: [], manifest: reading.kind };
	}
	const folded = new Set(reading.privateProducers.map(foldName));
	const kept: RecordFile[] = [];
	const leftOut = new Set<string>();
	for (const f of files) {
		const segs = f.rel.split("/");
		if (segs.length > 2 && segs[0] === RECORDS_DIR && folded.has(foldName(segs[1]))) {
			leftOut.add(segs[1]);
			continue;
		}
		kept.push(f);
	}
	return { files: kept, leftOut: [...leftOut].sort(), manifest: reading.kind };
}

/** The private producers a world's records name, for the export's option; empty when none or unreadable. */
export function privateProducersIn(files: RecordFile[]): string[] {
	const manifestFile = files.find((f) => f.rel === RECORDS_MANIFEST) ?? null;
	const reading = readRecordsManifest(manifestFile ? manifestFile.data : null);
	if (reading.kind !== "readable") return [];
	const dirs = new Set(files.map((f) => f.rel.split("/")).filter((s) => s.length > 2 && s[0] === RECORDS_DIR).map((s) => s[1]));
	const folded = new Set(reading.privateProducers.map(foldName));
	return [...dirs].filter((d) => folded.has(foldName(d))).sort();
}

/** The report's sentences about records (empty when the world has none). */
export function recordsReportLines(plan: RecordsPlan | null): string[] {
	if (!plan) return [];
	const lines: string[] = [];
	const n = plan.files.length;
	if (n > 0) lines.push(`${n} record file${n === 1 ? "" : "s"} carried in records/, byte for byte`);
	if (plan.leftOut.length > 0) {
		lines.push(
			`Private records left out: ${plan.leftOut.join(", ")}. RECORDS.json still lists them; turn on Include private records to carry them.`
		);
	}
	if (plan.manifest === "absent" && n > 0) {
		lines.push("records/ has no RECORDS.json, so every record went out: nothing was left out by guess.");
	} else if (plan.manifest === "unreadable") {
		lines.push("records/RECORDS.json could not be read, so every record went out: nothing was left out by guess.");
	}
	return lines;
}
