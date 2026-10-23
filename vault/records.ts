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
 * the SDK's table), so `Fold` names `records/fold/`.
 *
 * A manifest the plugin cannot read leaves nothing out by guess and carries
 * nothing by guess either (§4.7 OW-8: the writer refuses, or the caller asks;
 * Amendment A, Kael h69 #11140): the export asks with one switch, off by
 * default; off, no producer directory goes out and `RECORDS.json` still
 * travels byte-exact (the label travels, never the notes); on, everything
 * travels whole. With no manifest at all nothing can be private, so every
 * record travels.
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
 *   - `unreadable`: not UTF-8 JSON, not an array, or an entry that is not an
 *     object naming its directory (a non-empty string `producer`): which
 *     records are private cannot be told;
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
		if (typeof producer !== "string" || producer === "") {
			return { kind: "unreadable", why: "holds an entry with no producer name" };
		}
		if (isPrivate === true) privateProducers.push(producer);
	}
	return { kind: "readable", privateProducers };
}

/** What an export of a world's records writes, and what its report says. */
export interface RecordsPlan {
	/** The files that travel, byte for byte as held, in the order given. */
	files: RecordFile[];
	/**
	 * The producers left out (sorted): a private one as its manifest entry
	 * spells it, never the folded name; under an unreadable manifest, every
	 * producer directory by its own name.
	 */
	leftOut: string[];
	/** The manifest as read: `absent` carries every record; `unreadable` carries them only when asked. */
	manifest: ManifestReading["kind"];
	/** Whether the person turned the export's records switch on. */
	asked: boolean;
}

/** The producer directory a record file sits in, or null for a file at `records/`'s root. */
function producerDir(rel: string): string | null {
	const segs = rel.split("/");
	return segs.length > 2 && segs[0] === RECORDS_DIR ? segs[1] : null;
}

/**
 * Which of a world's record files an export writes (rule 6 and rule 11, §4.7
 * OW-8). `asked` is the export's one switch. A readable manifest: a file in a
 * private producer's directory is left out unless asked. An unreadable one:
 * every producer directory is left out unless asked (nothing carried by
 * guess). No manifest: everything travels. A file at `records/`'s root,
 * `RECORDS.json` among them, always travels as it is.
 */
export function planRecords(files: RecordFile[], asked: boolean): RecordsPlan {
	const manifestFile = files.find((f) => f.rel === RECORDS_MANIFEST) ?? null;
	const reading = readRecordsManifest(manifestFile ? manifestFile.data : null);
	// The name a left-out directory is reported by, or null when it travels:
	// a private producer as its manifest entry spells it ("Fold"), the fold
	// only matching it to its directory; under an unreadable manifest, which
	// names nothing, the directory's own name.
	let leaves: (dir: string) => string | null;
	if (asked || reading.kind === "absent") leaves = () => null;
	else if (reading.kind === "unreadable") leaves = (dir) => dir;
	else {
		const spelled = privateSpellings(reading.privateProducers);
		leaves = (dir) => spelled.get(foldName(dir)) ?? null;
	}
	const kept: RecordFile[] = [];
	const leftOut = new Set<string>();
	for (const f of files) {
		const dir = producerDir(f.rel);
		const name = dir === null ? null : leaves(dir);
		if (name !== null) {
			leftOut.add(name);
			continue;
		}
		kept.push(f);
	}
	return { files: kept, leftOut: [...leftOut].sort(), manifest: reading.kind, asked };
}

/** Folded name -> the manifest's own spelling, the first entry's when two fold alike. */
function privateSpellings(producers: string[]): Map<string, string> {
	const spelled = new Map<string, string>();
	for (const p of producers) if (!spelled.has(foldName(p))) spelled.set(foldName(p), p);
	return spelled;
}

/**
 * The export's records switch, when the world's records call for one: the
 * private producers a readable manifest names and the folder holds, as the
 * manifest spells them ("Include private records"), or an unreadable manifest beside producer
 * directories ("Include every record"). Null when there is nothing to ask.
 */
export type RecordsOption = { kind: "private"; producers: string[] } | { kind: "unreadable" };

export function recordsOption(files: RecordFile[]): RecordsOption | null {
	const manifestFile = files.find((f) => f.rel === RECORDS_MANIFEST) ?? null;
	const reading = readRecordsManifest(manifestFile ? manifestFile.data : null);
	const dirs = new Set(files.map((f) => producerDir(f.rel)).filter((d): d is string => d !== null));
	if (reading.kind === "unreadable") return dirs.size > 0 ? { kind: "unreadable" } : null;
	if (reading.kind !== "readable") return null;
	const spelled = privateSpellings(reading.privateProducers);
	const producers = [...new Set([...dirs].map((d) => spelled.get(foldName(d))).filter((p): p is string => p !== undefined))].sort();
	return producers.length > 0 ? { kind: "private", producers } : null;
}

/** The switch's words, sentence case in the plugin's voice. */
export const INCLUDE_PRIVATE_RECORDS = "Include private records";
export const INCLUDE_EVERY_RECORD = "Include every record (the records list could not be read)";

/** The sentence under the switch: the private producers as the manifest spells them. */
export function recordsSwitchDesc(option: RecordsOption): string {
	return option.kind === "private"
		? `This world's records mark ${option.producers.join(", ")} as private. Off, they stay out of the folder; RECORDS.json still lists them.`
		: "This world's RECORDS.json could not be read, so which records are private is not known. Off, no producer's records go out; RECORDS.json goes out unchanged.";
}

/** The report's sentences about records (empty when the world has none). */
export function recordsReportLines(plan: RecordsPlan | null): string[] {
	if (!plan) return [];
	const lines: string[] = [];
	const n = plan.files.length;
	if (n > 0) lines.push(`${n} record file${n === 1 ? "" : "s"} carried in records/, byte for byte`);
	if (plan.manifest === "unreadable") {
		if (plan.leftOut.length > 0) {
			lines.push(
				`records/RECORDS.json could not be read, so no producer's records went out (${plan.leftOut.join(", ")}) and RECORDS.json went out unchanged; turn on ${INCLUDE_EVERY_RECORD} to carry them.`
			);
		} else if (plan.asked) {
			lines.push("records/RECORDS.json could not be read, and you asked for every record, so every record went out.");
		}
	} else if (plan.leftOut.length > 0) {
		lines.push(
			`Private records left out: ${plan.leftOut.join(", ")}. RECORDS.json still lists them; turn on ${INCLUDE_PRIVATE_RECORDS} to carry them.`
		);
	}
	if (plan.manifest === "absent" && n > 0) {
		lines.push("records/ has no RECORDS.json, so every record went out: nothing can be private without one.");
	}
	return lines;
}
