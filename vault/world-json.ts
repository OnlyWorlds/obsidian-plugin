/**
 * world.json <-> the vault — PURE logic, NO Obsidian imports (unit-tested
 * under `npm test`).
 *
 * The folder format (spec §4.1) says a writer MUST NOT invent data and MUST NOT
 * drop data it has: every world.json key the source carried comes back out.
 * The plugin keeps world-level fields in two places:
 *
 *   - World.md, the note the user reads and edits. Its line list shows the
 *     description, the time settings and the units (the same template every
 *     other world command writes, Scripts/WorldDataTemplate.ts).
 *   - The world block of the folder sidecar (`.ow-folder.json`, see
 *     folder-sidecar.ts): the imported world.json as it was, minus `api`. It
 *     holds what World.md has no line for (image_url, created_at, public_read,
 *     the snapshot keys, format_version, extension keys), keeps each value's
 *     type (a list with a comma in an item, a multi-line description) and the
 *     key order the file used. The import reads the wire's
 *     `time_range_current`; the export writes it as the schema's `time_current`
 *     (spec §5: an export is a new folder in the current dialect).
 *
 *   - The server block of the same sidecar (3.8.0): what a Download read from
 *     `GET /world`, as served, and the server's origin. A downloaded world's
 *     export starts from it (every key the server served goes out, the world
 *     keeps its server id) and names it in `source`.
 *
 * On export, a key World.md shows is taken from World.md only when the user
 * changed its line; an unchanged line means the sidecar's value goes out
 * verbatim. So a folder that comes in and goes out untouched is byte-identical,
 * and an edit in World.md still travels.
 *
 * `api` (sync switch + credential) is never kept. Where the plugin does keep
 * credentials: a world's key in its World.md (API Key line), the account token
 * and a saved PIN in this vault's plugin data (data.json). Neither ever goes
 * into an export. A folder's `api` block is dropped at import, so a world that
 * came from a folder is a local world here (World.md says `local`) and its
 * export is a local world (spec §4.1: absent `api` = local-only).
 */
import { worldTemplateString } from "../Scripts/WorldDataTemplate";
import { LOCAL_WORLD_KEY_TOKEN } from "./world-key-core";
import { safeWorldFolderName } from "./world-name";

type LineKind = "text" | "number" | "list";

interface WorldLine {
	label: string;
	/** world.json spellings; the first is the default and the template's variable. */
	keys: string[];
	kind: LineKind;
}

/** The World.md lines that carry a world.json key, in template order. */
export const WORLD_MD_LINES: readonly WorldLine[] = [
	{ label: "Description", keys: ["description"], kind: "text" },
	{ label: "Version", keys: ["version"], kind: "text" },
	{ label: "Time Formats", keys: ["time_format_names"], kind: "list" },
	{ label: "Time Format Equivalents", keys: ["time_format_equivalents"], kind: "list" },
	{ label: "Basic Time Unit", keys: ["time_basic_unit"], kind: "text" },
	{ label: "Time Range Min", keys: ["time_range_min"], kind: "number" },
	{ label: "Time Range Max", keys: ["time_range_max"], kind: "number" },
	// spec §5: the schema says time_current; the wire says time_range_current.
	// Both are read; an export writes time_current (buildWorldJson).
	{ label: "Current Time", keys: ["time_current", "time_range_current"], kind: "number" },
	{ label: "Length Unit", keys: ["length_unit"], kind: "text" },
	{ label: "Mass Unit", keys: ["mass_unit"], kind: "text" },
	{ label: "Distance Unit", keys: ["distance_unit"], kind: "text" },
];

/**
 * The folder format spec version this writer follows (spec §4.2's
 * `format_version` row: "SHOULD be written by any writer"; it moves when the
 * spec's version moves). Every plugin export is a folder's birth (both
 * sinks refuse an existing folder), so every export stamps it, replacing any
 * value the imported world carried: the bytes are this version's.
 */
// 0.3.14 since 3.8.1: `exported_as` from /me (0.3.9) was the one writer rule
// from 0.3.8 to 0.3.14 the export did not meet; `source` and `producer` came in
// 3.8.0, a known-of note goes out as its stub (0.3.10), the plugin re-keys no
// id (0.3.11), writes no `records/` (0.3.12) and no `.owworld` (0.3.13).
// 0.3.15 since 3.10: its change is records marked private (§4.7's OW-8
// clause, §4.5 rules 11 and 12), and the plugin wrote no `records/` at all,
// so no private record could travel.
// 0.3.16 since 3.11: a server export carries `origin` as
// served (§4.2; a downloaded world's `GET /world` body goes out whole, so
// `origin` travels as keel served it, both members, `null` kept), and the
// folder export now carries `records/` byte for byte, private producers left
// out unless asked (Commands/ExportFolderCommand.ts, vault/records.ts).
export const FOLDER_FORMAT_VERSION = "0.3.16";

/**
 * The `exported_as` line (spec §4.2, v0.3.9): which slice of the world this
 * folder is, as the key that read it answers GET /me.
 */
export interface ExportedAs {
	kind: "owner" | "member" | "character" | "public";
	role: string | null;
	character: { id: string; name: string } | null;
}

/**
 * GET /me's answer mapped as spec §4.2 spells it (Kael's table, 2026-10-19):
 * the owner (an owner-minted or classic key) → owner, role owner, no
 * character; a co-builder or contributor → member with its role, no
 * character; a guest of any kind (person, agent seat, player) → character,
 * with the Character it reads as. `characterName` names that Character; null
 * when nothing in hand names it, and then no line is written (absent, never
 * guessed), as for an answer this mapping does not know.
 */
export function exportedAsFromMe(me: Record<string, unknown>, characterName: (id: string) => string | null): ExportedAs | null {
	const role = typeof me.role === "string" ? me.role : null;
	if (me.kind === "owner" || role === "owner") return { kind: "owner", role: "owner", character: null };
	if (role === "co_builder" || role === "contributor") return { kind: "member", role, character: null };
	if (role === "guest") {
		const id = typeof me.character === "string" && me.character ? me.character : null;
		if (!id) return { kind: "character", role, character: null };
		const name = characterName(id);
		return name === null ? null : { kind: "character", role, character: { id, name } };
	}
	return null;
}

/**
 * The producer line (spec §4.2, v0.3.14): which tool made the folder and from
 * what. The plugin's export is always made from the vault's notes, so its
 * `input` is `obsidian-vault`, a downloaded world's included (its `source`
 * says which server world the vault holds).
 */
export interface FolderProducer {
	tool: string;
	version: string;
	input: string;
}

export const PRODUCER_INPUT = "obsidian-vault";

/** The producer line for this plugin, or null when its manifest is not known (never guessed). */
export function pluginProducer(manifest: { id?: unknown; version?: unknown } | null | undefined): FolderProducer | null {
	if (!manifest || typeof manifest.id !== "string" || !manifest.id || typeof manifest.version !== "string" || !manifest.version) return null;
	return { tool: manifest.id, version: manifest.version, input: PRODUCER_INPUT };
}

/**
 * The server world a Download recorded for this world folder (the sidecar's
 * `server` block, folder-sidecar.ts): the server's origin and `GET /world`'s
 * body as served. Its `id` is the world's id; its keys are what the vault
 * holds of the world beyond World.md's lines.
 */
export interface ServerWorld {
	server: string;
	world: Record<string, unknown>;
}

/**
 * The provenance keys a writer of this spec owns (§4.2); never taken from a
 * server's world body. `origin` is not one: it is the server's own key (the
 * world's first import, served on `GET /world`), so it goes out as served,
 * like every world key, and is absent only when no server is behind the world.
 */
const PROVENANCE_KEYS = [
	"source", "exported_as", "producer", "format_version",
	"snapshot_of", "snapshot_label", "snapshot_at", "snapshot_change_seq", "snapshot_torn", "snapshot_counts", "writable",
];

/** The server world's id, when it is one (a non-empty string). */
export function serverWorldId(server: ServerWorld | null | undefined): string | null {
	const id = server?.world?.id;
	return typeof id === "string" && id.trim() !== "" ? id : null;
}

/**
 * The world.json keys the plugin never keeps: `api` holds a folder's sync
 * credential. Dropped at import (World.md gets `local`, not this key), so the
 * world is local here and its export is a local world (no `api` = do not sync,
 * spec §4.1). An export never carries any credential.
 */
export const WORLD_KEYS_NOT_KEPT = ["api"] as const;

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineRegex(label: string): RegExp {
	return new RegExp(`^- \\*\\*${escapeRe(label)}:\\*\\*[ \\t]*(.*?)[ \\t]*\\r?$`, "m");
}

/** The World.md line values present in `md`, by label (an absent line is absent). */
export function parseWorldMdLines(md: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of WORLD_MD_LINES) {
		const m = lineRegex(line.label).exec(md);
		if (m) out[line.label] = m[1];
	}
	return out;
}

/** How a world.json value reads on its one World.md line. */
export function worldLineText(value: unknown, kind: LineKind): string {
	if (value === undefined || value === null) return "";
	if (Array.isArray(value) && kind === "list") {
		return value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(",").replace(/\r?\n/g, " ").trim();
	}
	if (typeof value === "string") return value.replace(/\r?\n/g, " ").trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

/** A World.md line the user edited, read back as the key's kind. */
export function coerceWorldLine(text: string, kind: LineKind): unknown {
	const t = text.trim();
	if (kind === "number") {
		if (t === "") return null;
		return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
	}
	if (kind === "list") {
		if (t === "") return [];
		if (t.startsWith("[") && t.endsWith("]")) {
			try {
				const v = JSON.parse(t);
				if (Array.isArray(v)) return v;
			} catch {
				/* fall through to the comma list */
			}
		}
		return t.split(",").map((s) => s.trim()).filter((s) => s !== "");
	}
	return t;
}

/** The world.json an import keeps in the sidecar: everything but `api`. */
export function worldJsonToKeep(worldJson: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(worldJson)) {
		if ((WORLD_KEYS_NOT_KEPT as readonly string[]).includes(k)) continue;
		out[k] = v;
	}
	return out;
}

/** World.md for a world that came from a folder (a local world: no key). */
export function renderWorldMd(worldJson: Record<string, unknown>, worldName: string): string {
	const data: Record<string, string> = { api_key: LOCAL_WORLD_KEY_TOKEN, name: worldName };
	for (const line of WORLD_MD_LINES) {
		const key = line.keys.find((k) => k in worldJson) ?? line.keys[0];
		data[line.keys[0]] = worldLineText(worldJson[key], line.kind);
	}
	const md = worldTemplateString.replace(/\{\{(\w+)\}\}/g, (_w, v: string) => data[v] ?? "");
	return (
		md +
		"\n## From an OnlyWorlds folder\n" +
		"This world was imported from an OnlyWorlds folder. What this note has no line for " +
		"(the image, the folder's provenance, extension fields) is kept beside it and goes " +
		"back out unchanged when you export the world as a folder.\n"
	);
}

/**
 * The world.json an export writes.
 *
 * `server` is the sidecar's server block (a downloaded world): when present it
 * stands in for `kept`, and `source` and the producer line follow it (spec
 * §4.2). `kept` is the sidecar's world block (an imported world; null for a
 * world made in the vault).
 * Without either: id, name, and every World.md line that has a value, and the
 * producer line. With one: the
 * kept world.json in its key order (`time_range_current` written as
 * `time_current`), each World.md-shown key replaced only where the user
 * changed its line. Both end with
 * `format_version` = FOLDER_FORMAT_VERSION, whatever the world carried.
 *
 * The name is the world's folder name (the plugin's world identity, as before);
 * the kept spelling wins when it trims to the same name.
 */
export function buildWorldJson(opts: {
	worldId: string;
	worldName: string;
	worldMd: string | null;
	kept: Record<string, unknown> | null;
	/** The server world a Download recorded; when present it is the base, and `source` names it. */
	server?: ServerWorld | null;
	/** This writer's producer line (pluginProducer); null writes none. */
	producer?: FolderProducer | null;
	/** The export's clock, for `source.at`. */
	exportedAt?: string;
	/** Which slice the world's key reads (exportedAsFromMe), for a downloaded world; null or absent writes none. */
	exportedAs?: ExportedAs | null;
}): Record<string, unknown> {
	const { worldId, worldName, worldMd } = opts;
	const lines = worldMd ? parseWorldMdLines(worldMd) : {};
	const server = serverWorldId(opts.server) ? opts.server ?? null : null;
	const producer = opts.producer ?? null;

	// Which world.json the vault holds, in order: the server world a Download
	// recorded (the folder IS that world: spec §4.1's linked-folder ruling),
	// else what an import kept, else none (a world made in the vault).
	let kept: Record<string, unknown> | null = opts.kept;
	if (server) {
		kept = {};
		for (const [k, v] of Object.entries(server.world)) {
			if ((WORLD_KEYS_NOT_KEPT as readonly string[]).includes(k) || k === "api_key" || PROVENANCE_KEYS.includes(k)) continue;
			kept[k] = v;
		}
	}

	if (!kept) {
		const out: Record<string, unknown> = { id: worldId, name: worldName };
		for (const line of WORLD_MD_LINES) {
			const text = lines[line.label];
			if (text === undefined || text.trim() === "") continue;
			out[line.keys[0]] = coerceWorldLine(text, line.kind);
		}
		// Made in the vault: this export is its maker (§4.2 producer row).
		if (producer) out.producer = producer;
		out.format_version = FOLDER_FORMAT_VERSION;
		return out;
	}

	const out: Record<string, unknown> = { ...kept };
	out.id = worldId;
	// The folder is the name's safe form (world-name.ts), so a kept name
	// whose safe form is this folder is still the world's own name.
	const keptName = typeof kept.name === "string" ? kept.name : null;
	// A downloaded world's name is the server's (its folder may be `Name (1)`).
	out.name = keptName !== null && (server || keptName.trim() === worldName || safeWorldFolderName(keptName) === worldName) ? keptName : worldName;
	for (const line of WORLD_MD_LINES) {
		const text = lines[line.label];
		if (text === undefined) continue; // no line: the kept value (or its absence) stands
		const key: string = line.keys.find((k) => k in kept) ?? line.keys[0];
		if (key in kept) {
			if (text.trim() === worldLineText(kept[key], line.kind)) continue; // unchanged
			out[key] = coerceWorldLine(text, line.kind);
		} else if (text.trim() !== "") {
			out[key] = coerceWorldLine(text, line.kind);
		}
	}
	// An export is a new folder, so it speaks the current dialect (spec §5):
	// the wire's `time_range_current` goes out as the schema's `time_current`,
	// at the same position. When both were carried, `time_current` stands
	// (Kael's review 3.6, the coordinator's ruling).
	if ("time_range_current" in out) {
		if ("time_current" in out) {
			delete out.time_range_current;
		} else {
			const renamed: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(out)) renamed[k === "time_range_current" ? "time_current" : k] = v;
			for (const k of Object.keys(out)) delete out[k];
			Object.assign(out, renamed);
		}
	}
	// Provenance (§4.2). A downloaded world: `source` names the server world
	// (`at` the export's clock), `exported_as` the slice its key reads (from
	// GET /me; absent when no key or no answer says it, never guessed), and
	// this plugin is the folder's maker; no `snapshot_*` (not a snapshot: the
	// world keeps its id). An imported world keeps the lines it came with as
	// it found them, absent ones absent (the producer row: a tool that writes
	// a folder from another folder keeps the line).
	if (server) {
		out.source = { server: server.server, world: serverWorldId(server), at: opts.exportedAt ?? new Date().toISOString() };
		if (opts.exportedAs) out.exported_as = opts.exportedAs;
		if (producer) out.producer = producer;
	}
	// Every export is a birth: both sinks refuse an existing folder, so the
	// folder is new and written now, against this writer's version. A carried
	// value is replaced in place (its key keeps its position).
	out.format_version = FOLDER_FORMAT_VERSION;
	return out;
}
