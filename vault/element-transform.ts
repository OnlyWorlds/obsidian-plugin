/**
 * Pure element-transform logic — NO Obsidian imports.
 *
 * This module holds the serialization/parsing logic that the frontmatter flip
 * depends on, factored out so it can be unit-tested under plain `node --test`
 * (see test/element-transform.test.ts). The Obsidian-facing wiring lives in
 * vault/element-file.ts and calls into here.
 *
 * Everything here operates on plain JS values (strings, objects, arrays) — the
 * YAML string <-> object boundary is Obsidian's job (parseYaml/stringifyYaml /
 * processFrontMatter), not this module's.
 *
 * The @onlyworlds/sdk import is plain data (FIELD_SCHEMA) with no runtime deps,
 * so it stays pure.
 */

import { FIELD_SCHEMA } from "@onlyworlds/sdk";
import { decodeHtmlEntities } from "../Scripts/htmlEntities";

/** Field descriptor shape as exported by the SDK's FIELD_SCHEMA. */
export interface SchemaField {
	type: "text" | "number" | "single_link" | "multi_link";
	target?: string;
	required?: boolean;
}

type CategorySchema = Record<string, SchemaField>;

/**
 * Extension-field namespaces that MUST round-trip verbatim (R3 / Temper's law).
 * Any frontmatter key starting with one of these is foreign, READ-ONLY data —
 * the plugin never rewrites or drops it. Atlas self-healing depends on it.
 * Kept in sync with keel's EXTENSION_FIELD_NAMESPACES.
 */
export const EXTENSION_NAMESPACES = ["atlas_", "shadow_", "x_"] as const;

export function isExtensionKey(key: string): boolean {
	return EXTENSION_NAMESPACES.some((ns) => key.startsWith(ns));
}

/**
 * The user's own custom fields: `x_` only. Only these become body sections;
 * `atlas_` and `shadow_` are tools' namespaces and stay in the frontmatter
 * verbatim (OW Infra #166 row 12; spec §3.3, foreign fields are read-only).
 */
export function isUserCustomKey(key: string): boolean {
	return key.startsWith(EXTENSION_NAMESPACES[2]);
}

/**
 * The `x_` keys a body heading would be read as if it were a section copy of a
 * tool's key in this frontmatter (`atlas_color` -> `x_color`). Older plugin
 * versions wrote such copies; readElement consumes them instead of adopting
 * them as user fields.
 */
export function toolShadowHeadings(frontmatter: Record<string, unknown>): Set<string> {
	const out = new Set<string>();
	for (const k of Object.keys(frontmatter)) {
		if (!isExtensionKey(k) || isUserCustomKey(k)) continue;
		out.add(`${EXTENSION_NAMESPACES[2]}${headingToFieldKey(stripExtensionPrefix(k))}`);
	}
	return out;
}

/** Meta keys that never belong in an outbound API payload. */
const NON_PAYLOAD_KEYS = new Set(["id", "world", "world_id", "position", "aliases", "tags"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * If `value` is a `[[Name]]` or `[[Name|Alias]]` wikilink string, return the
 * target Name (the identity part, before any pipe). Otherwise null. Whitespace
 * inside the brackets is trimmed. Used on READ to turn readable link fields back
 * into ids (R1).
 */
export function wikilinkTarget(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const m = /^\[\[([^\]]+?)\]\]$/.exec(value.trim());
	if (!m) return null;
	const inner = m[1];
	const name = (inner.includes("|") ? inner.slice(0, inner.indexOf("|")) : inner).trim();
	return name.length ? name : null;
}

/** Wrap a display name as a `[[Name]]` wikilink string (WRITE side, R1). */
export function toWikilink(name: string): string {
	return `[[${name}]]`;
}

/**
 * A value is "empty" for R3 omit-purposes when it is null/undefined, an empty
 * or whitespace-only string, or an empty array. Numbers (incl. 0) and booleans
 * (incl. false) are NEVER empty — they are real values.
 */
export function isEmptyFieldValue(value: unknown): boolean {
	if (value == null) return true;
	if (typeof value === "string") return value.trim().length === 0;
	if (Array.isArray(value)) return value.length === 0;
	return false;
}

/**
 * Resolver injected by the Obsidian layer so the pure transform can render link
 * fields readably. Maps an element id -> its display name (or null when the id
 * has no local note — a dangling/cross-world link the raw id must survive as).
 */
export type IdToName = (id: string) => string | null;

/**
 * Resolver injected by the Obsidian layer so the pure transform can turn a
 * `[[Name]]` link value back into an id. Path-aware resolution (same-name
 * disambiguation) lives in the caller; this fn just maps a resolved Name -> id,
 * or null when the name resolves to no element / an element without an id.
 */
export type NameToId = (name: string, target?: string) => string | null | typeof AMBIGUOUS_LINK;

/**
 * What a NameToId returns when a name in a GENERIC-target link field (target
 * `any`, e.g. a Pin's `element_id`) matches notes of more than one type. The
 * link is never guessed: it is left out and reported (ReadLinkOptions.ambiguous).
 */
export const AMBIGUOUS_LINK: unique symbol = Symbol("ambiguous-link");

/**
 * Render a single already-normalized link id as its readable frontmatter form:
 * `[[Name]]` when the resolver knows the id, else the raw id (dangling/cross-world
 * links are never lost). A value that is already a `[[wikilink]]` is passed
 * through untouched (idempotent re-write).
 */
function renderLinkId(id: string, resolve?: IdToName): string {
	if (!resolve) return id;
	if (wikilinkTarget(id) != null) return id; // already readable
	const name = resolve(id);
	return name ? toWikilink(name) : id;
}

/** Lowercase, trim a category string ("Character" -> "character"). */
export function normalizeCategory(category: string): string {
	return category.toLowerCase().trim();
}

/**
 * The note body maps to `story` for Narrative, `description` for every other
 * type (R5, Captain ruling 2026-07-13 §7.3). On read body -> this field; on
 * write this field -> body.
 */
export function bodyFieldForCategory(category: string): "story" | "description" {
	return normalizeCategory(category) === "narrative" ? "story" : "description";
}

// --- body sections (v3.2 format) ---------------------------------------------
//
// TEXT fields live in the BODY under `## Heading` sections; frontmatter carries
// base + numbers + links only. Rationale (2026-08-22): Obsidian's Properties
// panel cannot group or collapse (its docs list nested YAML as unsupported), and
// a one-line property input is the wrong instrument for prose. Markdown headings
// fold natively — which is what the 1.x span format got right and 3.0 lost.
//
// This is a PLUGIN-LOCAL layout choice, not a format change: the OnlyWorlds
// folder format is JSON per element, and Atlas never reads markdown. What
// crosses any boundary is field VALUES, unchanged.

/**
 * The heading level field sections are WRITTEN at. `###` rather than `##`:
 * a note is 3-7 sections of usually-short prose, and h2 renders large enough
 * to dominate the content it labels (Captain, 2026-08-22).
 *
 * ★ READING takes ONLY this level as a field boundary. Any other heading in a
 * field's text (`#`, `##`, `####` and deeper) is the user's prose and stays in
 * that field. Reading `##` as a boundary too split a description at a
 * `## Notes` line into an `x_notes` field, and let a `## Background` line in a
 * description be overwritten by the real Background section (OW Infra #166
 * row 1, hop 9 #4). Every released 3.2+ build writes `###` (3.2.0 onward).
 */
const SECTION_HEADING = "###";

/** `political_climate` -> `Political Climate`. The heading a text field gets. */
export function fieldToHeading(key: string): string {
	return key
		.split("_")
		.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w))
		.join(" ");
}

/** `## Political Climate` / `political climate` / `Political_Climate` -> `political_climate`. */
export function headingToFieldKey(heading: string): string {
	return heading.trim().toLowerCase().replace(/\s+/g, "_");
}

/**
 * Base identity keys that stay in FRONTMATTER even though the schema types them
 * `text` (§2 ordering ruling). They are short classifiers and a URL, not prose:
 * `supertype`/`subtype` are one-word categories, `image_url` is a link, and
 * `name`/`id` are identity. A `## Supertype` section holding the word "noble"
 * would be absurd, and these are the fields a reader scans first.
 *
 * NOTE this is NOT the rejected "scalar-ish text field" exception list (Q2 ruled
 * all text fields to the body, including map.background_color). This is the base
 * block, which §2 already places in frontmatter by name.
 */
const BASE_FRONTMATTER_KEYS = new Set(["name", "id", "supertype", "subtype", "image_url"]);

/**
 * The text fields of a category, in schema order — these are the body sections.
 * The body field (description/story) is FIRST and always present, then the rest
 * in schema order. Custom `x_` text fields are appended by the caller.
 */
export function bodyTextFields(category: string): string[] {
	const schema = getCategorySchema(category);
	const bodyField = bodyFieldForCategory(category);
	if (!schema) return [bodyField];
	const rest = Object.entries(schema)
		.filter(([k, def]) => def.type === "text" && k !== bodyField && !BASE_FRONTMATTER_KEYS.has(k))
		.map(([k]) => k);
	return [bodyField, ...rest];
}

/**
 * Render an element's body: one `## Heading` section per text field, in schema
 * order, INCLUDING empty ones — the empty section IS the scaffold, and is the
 * whole reason a user can discover a field exists.
 *
 * `extraTextFields` carries custom `x_` text fields (rendered without the
 * prefix: `x_looks` -> `## Looks`).
 */
export function buildElementBody(
	values: Record<string, unknown>,
	category: string,
	extraTextFields: string[] = [],
	/**
	 * Restrict the schema fields rendered (Manage-fields). Order still comes from
	 * the schema, never from this list — a note added to and removed from many
	 * times still reads canonically. Omit for the full scaffold.
	 */
	onlyFields?: string[]
): string {
	const schemaKeys = onlyFields
		? bodyTextFields(category).filter((k) => onlyFields.includes(k))
		: bodyTextFields(category);
	const keys = [...schemaKeys, ...extraTextFields];
	const parts: string[] = [];
	for (const key of keys) {
		const label = fieldToHeading(isExtensionKey(key) ? stripExtensionPrefix(key) : key);
		const raw = values[key];
		// The value as it is, never trimmed (OW Infra #166 row 16): sectionValue
		// strips exactly the layout written here and nothing of the value.
		const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
		// An EMPTY section still gets its blank line: the gap is where the user
		// types, and without it the cursor lands against the next heading.
		parts.push(`${SECTION_HEADING} ${label}\n\n${text ? `${text}\n` : ""}`);
	}
	return parts.join("\n");
}

/**
 * The line ending of the body's last `###` section heading, the one
 * sectionValue reads that section's layout by; `\n` when there is none. A
 * CRLF inside a value says nothing about the layout (Kael's cold read, 4: a
 * CRLF anywhere in the body used to pick `\r\n` and corrupted the last value).
 */
function lastSectionEol(body: string): string {
	let eol = "\n";
	let inFence = false;
	let pos = 0;
	for (;;) {
		const nl = body.indexOf("\n", pos);
		let line = body.slice(pos, nl < 0 ? body.length : nl);
		const cr = line.endsWith("\r");
		if (cr) line = line.slice(0, -1);
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		if (!inFence && /^###[ \t]+(.+?)\s*$/.test(line)) eol = cr ? "\r\n" : "\n";
		if (nl < 0) return eol;
		pos = nl + 1;
	}
}

/**
 * A body with one more, empty `### Label` section at its end (Add Custom
 * Field). The last value already there keeps its trailing whitespace: the body
 * is closed with the layout's blank line only where it lacks one, which reads
 * back the same value (sectionValue), instead of being trimmed (OW Infra #166
 * row 16).
 */
export function appendBodySection(body: string, label: string): string {
	const eol = lastSectionEol(body);
	let b = body.trim() ? body : "";
	if (b && !b.endsWith(eol + eol)) b += b.endsWith(eol) ? eol : eol + eol;
	return `${b}${SECTION_HEADING} ${label}\n\n`;
}

/**
 * Split a note into its frontmatter block and its body — the ONE place that
 * decides where one ends and the other begins.
 *
 * ⚑ Tolerant of leading whitespace on READ, strict on WRITE. A note whose
 * `---` is preceded by blank lines is not valid frontmatter to Obsidian (it
 * renders the YAML as plain text), and a naive `content.startsWith("---")`
 * check reports "no frontmatter" — so the next rewrite writes the whole thing
 * as BODY and the corruption becomes permanent and self-perpetuating. Found
 * 2026-08-22 on a real note (`first char`) that had acquired three leading
 * newlines: every later edit pushed the frontmatter further into the body.
 *
 * So: recognise the block wherever it starts, and always re-emit it at byte 0.
 */
export function splitNote(content: string): { frontmatter: string; body: string } {
	const lead = /^\s*/.exec(content)?.[0].length ?? 0;
	const rest = content.slice(lead);
	if (!rest.startsWith("---")) return { frontmatter: "", body: content };
	const end = rest.indexOf("\n---", 3);
	if (end < 0) return { frontmatter: "", body: content };
	// The block ends at the closing `---`; the body is what follows it, with the
	// blank line(s) that separate them consumed so callers get the body itself
	// rather than the gap. joinNote re-inserts exactly one separator.
	// `end` indexes the "\n" before the closing "---", so the block runs to
	// end+4 and the body starts after the newline that terminates that line.
	const body = rest.slice(end + 4).replace(/^\r?\n/, "").replace(/^[ \t]*\r?\n/, "");
	return { frontmatter: rest.slice(0, end + 4), body };
}

/**
 * Serialize a frontmatter object to a `---` block, in key order.
 *
 * We emit this ourselves rather than going through Obsidian's
 * `processFrontMatter` because that call is async, owns the whole file, and on
 * a note with an empty body left blank lines above the `---` — which stops it
 * being frontmatter at all. Owning the bytes removes the failure class.
 *
 * Covers exactly the value shapes the schema produces: string, number, null,
 * boolean, and arrays of strings (link lists). Anything else — a nested object
 * from an `x_` extension key — is emitted as JSON on one line, which is valid
 * YAML and round-trips through every reader.
 *
 * ★ An ARRAY is a block list only when every item is a string, number or
 * boolean — the shapes `yamlScalar` can write. An array holding an object, an
 * array or a null (an `x_` list of recipe rows, `[1, "two", null]`) is emitted
 * as one-line JSON like any other structure. Sending those items through
 * `yamlScalar` wrote every object as the string "[object Object]" and every
 * null as "" — Sikelia's `x_inputs`/`x_wants` were destroyed on import (hop 9,
 * 2026-09-23). Link lists keep their block form, so existing notes don't churn.
 */
export function serializeFrontmatter(fm: Record<string, unknown>): string {
	const lines: string[] = ["---"];
	for (const [key, value] of Object.entries(fm)) {
		if (value === null || value === undefined) {
			lines.push(`${key}:`);
		} else if (Array.isArray(value)) {
			if (value.length === 0) lines.push(`${key}: []`);
			else if (!value.every(isBlockListItem)) lines.push(`${key}: ${JSON.stringify(value)}`);
			else {
				lines.push(`${key}:`);
				for (const item of value) lines.push(`  - ${yamlScalar(item)}`);
			}
		} else if (typeof value === "object") {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		} else {
			lines.push(`${key}: ${yamlScalar(value)}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

/** An array item `yamlScalar` writes faithfully (see serializeFrontmatter). */
function isBlockListItem(item: unknown): boolean {
	return (
		typeof item === "string" ||
		typeof item === "boolean" ||
		(typeof item === "number" && Number.isFinite(item))
	);
}

/**
 * Write a scalar so YAML reads back the SAME value. A string stays plain only
 * when no parser could take it for anything else; otherwise it is double-quoted
 * with escapes.
 *
 * ★ Obsidian's parser is js-yaml 4 (read off the shipped asar, hop 10). Plain
 * `2024-01-01` came back a timestamp, `1e3` the number 1000, and ` #` started
 * a comment that cut the value; a raw newline inside quotes broke the whole
 * block, so the note could not be read and the save failed (OW Infra #166
 * row 3, hop 9 #8). Quoting more than strictly needed costs nothing: quoted
 * and plain read back as the same string.
 */
function yamlScalar(value: unknown): string {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	const s = String(value ?? "");
	if (s === "") return '""';
	if (
		/^\s|\s$/.test(s) ||
		// a leading indicator character (flow, anchor, tag, block, quote, comment)
		/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
		// a leading digit, sign or dot: ints, floats, 1e3, 0x1F, .5, .inf, dates.
		// A uuid stays plain (it parses as no other type, and every element
		// note's `id:` line would otherwise churn).
		(/^[+.\d]/.test(s) && !UUID_RE.test(s)) ||
		// a mapping indicator or a comment start inside the value, or a trailing colon
		/:\s|\s#|:$/.test(s) ||
		// any control character, newlines included
		/[\x00-\x1f\x7f]/.test(s) ||
		// YAML 1.1 and 1.2 booleans and nulls
		/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s)
	) {
		return yamlDoubleQuoted(s);
	}
	return s;
}

/** A YAML double-quoted scalar: backslash, quote and control characters escaped. */
function yamlDoubleQuoted(s: string): string {
	const body = s
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
	return `"${body}"`;
}

/**
 * A Date that YAML made out of a string field, back to the string. js-yaml
 * reads a plain `2024-01-01` as a timestamp; a date-only value (UTC midnight)
 * returns as `YYYY-MM-DD`, exactly as typed. A value with a time cannot be
 * recovered byte for byte and returns as its ISO form. Anything else passes
 * through.
 */
export function dateToFieldString(value: unknown): unknown {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) return value;
	const iso = value.toISOString();
	return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
}

/**
 * The value of a schema TEXT field as the string the user typed, where
 * recoverable: a hand-typed `supertype: 5` or `subtype: true` parses as a
 * number or boolean and goes to the server as "5" / "true", never as 5 / true
 * (OW Infra #166 row 3). Dates as dateToFieldString. Only for text fields:
 * link, number and extension values pass through untouched.
 */
export function textFieldString(value: unknown): unknown {
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return dateToFieldString(value);
}

/**
 * Reassemble a note. The frontmatter block ALWAYS lands at byte 0 with exactly
 * one newline after it — never leading blank lines, whatever the input had.
 */
export function joinNote(frontmatter: string, body: string): string {
	const fm = frontmatter.trim();
	const b = body.replace(/^\s*\n/, "");
	if (!fm) return b;
	return `${fm}\n\n${b.replace(/^\n+/, "")}`;
}

/** `x_looks` -> `looks`. Only strips the namespace, never other content. */
export function stripExtensionPrefix(key: string): string {
	for (const ns of EXTENSION_NAMESPACES) {
		if (key.startsWith(ns)) return key.slice(ns.length);
	}
	return key;
}

export interface ParsedBody {
	/** field key -> section text, for headings matching a schema text field */
	fields: Record<string, string>;
	/**
	 * Headings that matched no schema text field, in document order, with their
	 * content and original heading text. NEVER discarded — the caller folds these
	 * back into the body field so no prose is ever lost (§R2 never-drop).
	 */
	unknown: Array<{ heading: string; text: string }>;
	/** Content appearing BEFORE the first `##` heading. Also never discarded. */
	preamble: string;
}

/**
 * A section's value from its raw text: everything after the heading line's own
 * line ending up to the next heading line. buildElementBody writes
 * `### Heading` EOL, EOL (the blank line), the value, EOL, and one more EOL
 * before the next heading (writeElement adds that last one after the final
 * section). Exactly that layout is stripped, so the value comes back byte for
 * byte: its own edge whitespace, CRLF and lone CR included (OW Infra #166 row
 * 16; it used to be trimmed and CRLF folded to LF).
 *
 * EOL is the heading line's own ending, so a note saved with CRLF throughout
 * by another editor strips CRLF layout the same way. An empty section is
 * nothing, one EOL or two.
 */
function sectionValue(raw: string, eol: string): string {
	if (raw === "" || raw === eol || raw === eol + eol) return "";
	let v = raw.startsWith(eol) ? raw.slice(eol.length) : raw;
	if (v.endsWith(eol + eol)) v = v.slice(0, -2 * eol.length);
	else if (v.endsWith(eol)) v = v.slice(0, -eol.length);
	return v;
}

/**
 * Parse a note body into its `###` field sections.
 *
 * Only `###` (SECTION_HEADING, the level the plugin writes) starts a section;
 * `#`, `##`, `####` and deeper belong to the prose of whatever section they sit
 * in, so a user's own structure survives. A fenced code block is skipped so a
 * heading inside ``` never splits a section.
 *
 * Each section's text is its value exactly (sectionValue): the body is walked
 * by offsets with every line ending kept, never split and re-joined (row 16).
 */
export function parseElementBody(body: string, category: string): ParsedBody {
	const known = new Set(bodyTextFields(category));
	const fields: Record<string, string> = {};
	const unknown: Array<{ heading: string; text: string }> = [];

	let current: { heading: string; start: number; eol: string } | null = null;
	let preambleEnd = body.length;
	let inFence = false;

	const flush = (end: number) => {
		if (!current) return;
		const text = sectionValue(body.slice(current.start, end), current.eol);
		const key = headingToFieldKey(current.heading);
		if (known.has(key)) {
			fields[key] = text;
		} else {
			unknown.push({ heading: current.heading, text });
		}
		current = null;
	};

	let pos = 0;
	for (;;) {
		const nl = body.indexOf("\n", pos);
		const next = nl < 0 ? body.length : nl + 1;
		let line = body.slice(pos, nl < 0 ? body.length : nl);
		const cr = line.endsWith("\r");
		if (cr) line = line.slice(0, -1);
		if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
		// Only `###` is a section boundary (row 1): `#`, `##` and `####`+ are
		// prose and stay inside the section they sit in.
		const m = !inFence ? /^###[ \t]+(.+?)\s*$/.exec(line) : null;
		if (m) {
			if (current) flush(pos);
			else preambleEnd = pos;
			current = { heading: m[1], start: next, eol: cr ? "\r\n" : "\n" };
		}
		if (nl < 0) break;
		pos = next;
	}
	flush(body.length);

	return { fields, unknown, preamble: body.slice(0, preambleEnd).trim() };
}

/**
 * Turn a parsed body into the field values to upload.
 *
 * ★ Never-drop (R2): unknown sections and any preamble are appended to the body
 * field (description/story) with their headings intact, rather than discarded.
 * A user who renames `## Background` to `## Backstory` loses nothing — the prose
 * lands in description and is visible, instead of vanishing.
 */
export function bodyToFieldValues(
	body: string,
	category: string,
	/**
	 * Custom field keys the note is known to carry (`x_looks`). A section whose
	 * heading matches one of these becomes that field instead of being salvaged
	 * into description — this is what makes a user-added field a real field
	 * rather than stray prose. Callers that don't track custom fields can omit
	 * it and get the pure never-drop behaviour.
	 */
	knownCustomKeys: string[] = []
): Record<string, string> {
	const parsed = parseElementBody(body, category);
	const bodyField = bodyFieldForCategory(category);
	const out: Record<string, string> = { ...parsed.fields };
	const customByHeading = new Map(
		knownCustomKeys.map((k) => [headingToFieldKey(stripExtensionPrefix(k)), k])
	);

	const salvage: string[] = [];
	if (parsed.preamble) salvage.push(parsed.preamble);
	for (const u of parsed.unknown) {
		const customKey = customByHeading.get(headingToFieldKey(u.heading));
		if (customKey) {
			out[customKey] = u.text;
			continue;
		}
		salvage.push(u.text ? `## ${u.heading}\n\n${u.text}` : `## ${u.heading}`);
	}
	if (salvage.length) {
		// The body field's own value leads unaltered; salvage follows it (row 16).
		const existing = out[bodyField] ? [out[bodyField]] : [];
		out[bodyField] = [...existing, ...salvage].join("\n\n");
	}
	return out;
}

/**
 * Fields the pinned SDK (2.2.2, standard 00.30.00) declares that the API does
 * not have. keel 422s them ("Unknown field: relations", measured on the wire
 * 2026-10-10, hop 10), and a 422 on one field fails the whole save, so a note
 * carrying such a key could never be saved. The SDK bump to 4.x removes the
 * need for this list; until then it is the plugin's view of the schema.
 */
export const API_DROPPED_FIELDS: Readonly<Record<string, readonly string[]>> = {
	relation: ["relations"],
};

/**
 * The generic link pair (Pin: `element_type` + `element_id`) keeps its wire
 * names on v2; only the v1 link suffixes (`location_id`, `abilities_ids`) are
 * stripped. keel 422s `element` ("Unknown field: element", measured 2026-10-10).
 */
export const GENERIC_PAIR_KEYS: ReadonlySet<string> = new Set(["element_type", "element_id"]);

const schemaCache = new Map<string, CategorySchema | null>();

export function getCategorySchema(category: string): CategorySchema | null {
	const cat = normalizeCategory(category);
	if (schemaCache.has(cat)) return schemaCache.get(cat)!;
	const raw = (FIELD_SCHEMA as Record<string, CategorySchema>)[cat] ?? null;
	const dropped = API_DROPPED_FIELDS[cat];
	let schema = raw;
	if (raw && dropped && dropped.length) {
		schema = Object.fromEntries(
			Object.entries(raw).filter(([key]) => !dropped.includes(key))
		) as CategorySchema;
	}
	schemaCache.set(cat, schema);
	return schema;
}

/** True when the API refuses this key for the category (see API_DROPPED_FIELDS). */
export function isApiDroppedField(category: string, key: string): boolean {
	return (API_DROPPED_FIELDS[normalizeCategory(category)] ?? []).includes(key);
}

/**
 * v2 wire keys: v1 link suffixes stripped (`location_id` -> `location`,
 * `abilities_ids` -> `abilities`), the generic pair kept, `world`/`world_id`
 * dropped (world identity is the API key). The transport's toV2Payload calls this.
 */
export function toV2WireKeys(element: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(element)) {
		if (key === "world" || key === "world_id") continue;
		if (GENERIC_PAIR_KEYS.has(key)) {
			out[key] = value;
		} else if (key.endsWith("_ids")) {
			out[key.slice(0, -4)] = value;
		} else if (key.endsWith("_id")) {
			out[key.slice(0, -3)] = value;
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Normalize a link field value to its canonical frontmatter shape.
 * - single_link -> a single id string (or null)
 * - multi_link  -> an array of id strings (never a comma-joined string; R4)
 *
 * Accepts the messy inputs the span era produced: comma-joined strings,
 * stub objects {id,name}, arrays of either, already-clean values.
 */
export function normalizeLinkValue(
	value: unknown,
	kind: "single_link" | "multi_link"
): string | string[] | null {
	const toId = (v: unknown): string | null => {
		if (v == null) return null;
		if (typeof v === "string") {
			const t = v.trim();
			return t.length ? t : null;
		}
		if (typeof v === "object" && v !== null && "id" in (v as Record<string, unknown>)) {
			const id = (v as Record<string, unknown>).id;
			return typeof id === "string" && id.trim().length ? id.trim() : null;
		}
		return null;
	};

	const flatten = (v: unknown): string[] => {
		if (v == null) return [];
		if (Array.isArray(v)) return v.flatMap(flatten);
		if (typeof v === "string" && v.includes(",")) {
			return v.split(",").map((s) => s.trim()).filter(Boolean);
		}
		const id = toId(v);
		return id ? [id] : [];
	};

	if (kind === "single_link") {
		const ids = flatten(value);
		return ids.length ? ids[0] : null;
	}
	// multi_link
	return flatten(value);
}

/**
 * Split a raw frontmatter object into the fields that belong in an outbound
 * API payload, preserving extension-namespaced keys verbatim (R3).
 *
 * - Known schema fields: kept, with link fields normalized to id shape.
 * - Extension keys (atlas_/shadow_/x_): kept verbatim, untouched.
 * - `id`, `world`, `world_id`, and Obsidian-native meta keys: dropped
 *   (id travels in the URL path, world is the API key).
 * - Unknown non-extension keys: dropped (they are not API fields and would
 *   422 the write) — but only for KNOWN categories; unknown categories keep
 *   everything and let the API arbitrate.
 *
 * The body-derived field (description/story) is NOT injected here — the caller
 * owns the body and layers it on top.
 */
/**
 * Options for reading link fields that may carry `[[Name]]` wikilinks (R1).
 *
 * `resolveNameToId` turns a resolved wikilink Name into an element id (path-aware
 * disambiguation is the caller's job — it hands us the winning Name). When
 * absent, wikilink values cannot be resolved and are treated as unresolvable
 * (reported, not guessed) — but raw-uuid link values always pass through, so a
 * vault-less unit test still round-trips id-shaped notes.
 *
 * `unresolved` (optional) collects `[[Name]]` targets that resolved to no id, so
 * the caller can surface the loss (never silently drop a link).
 */
export interface ReadLinkOptions {
	resolveNameToId?: NameToId;
	unresolved?: string[];
	/**
	 * When true, a link field with ANY unresolvable `[[Name]]` is OMITTED from
	 * the output entirely (not shortened). This matches the span-format upload
	 * guard: a full-field PATCH built from a REDUCED id list would silently strip
	 * the server's copy of the dropped link (the "2.3.0 smoke test class"). Set
	 * on the upload/read path; leave off where a partial list is acceptable.
	 */
	omitFieldOnUnresolved?: boolean;
	/**
	 * Collects frontmatter keys adopted as custom fields — a key that is neither
	 * a schema field nor already namespaced gets `x_` prepended so it survives
	 * the upload (the API rejects unknown bare keys outright). Each entry is
	 * `{ from: "mood", to: "x_mood" }`. The caller uses this to rewrite the key
	 * in the note and tell the user what was kept.
	 */
	adopted?: Array<{ from: string; to: string }>;
	/**
	 * Collects `[[Name]]` targets in a generic-target link field (target `any`)
	 * that matched notes of more than one type. Each is left out of the payload
	 * (its field omitted on the upload path) and the caller names it to the user
	 * (OW Infra #166 row 2).
	 */
	ambiguous?: string[];
	/**
	 * The type a generic-target link field (target `any`) names, from the note's
	 * own `element_type` (a Pin). When set, that field resolves against notes of
	 * this type only, like any typed link field; absent or empty, the generic
	 * rule applies (ambiguous -> left out and named).
	 */
	genericTargetType?: string;
}

/**
 * Resolve one link value to an id, tolerating both shapes (R1):
 *   - `[[Name]]` / `[[Name|Alias]]` -> resolved id (or null + reported unresolved)
 *   - a bare id string (uuid or otherwise) -> itself (dangling/unmigrated tolerance)
 *
 * `fieldTarget` is the link field's schema target type (`location`, or `any`
 * for a generic field); the resolver matches the name against notes of that
 * type only, so a Location and a Collective sharing a name never cross.
 */
function linkValueToId(value: unknown, opts: ReadLinkOptions, fieldTarget?: string): string | null {
	const target = wikilinkTarget(value);
	if (target != null) {
		const id = opts.resolveNameToId?.(target, fieldTarget) ?? null;
		if (id === AMBIGUOUS_LINK) {
			opts.ambiguous?.push(target);
			return null;
		}
		if (!id) {
			opts.unresolved?.push(target);
			return null;
		}
		return id;
	}
	// Not a wikilink — a raw id string (or empty). Keep as-is.
	if (typeof value === "string") {
		const t = value.trim();
		return t.length ? t : null;
	}
	return null;
}

export function frontmatterToPayloadFields(
	frontmatter: Record<string, unknown>,
	category: string,
	opts: ReadLinkOptions = {}
): Record<string, unknown> {
	const schema = getCategorySchema(category);
	const out: Record<string, unknown> = {};
	const bodyField = bodyFieldForCategory(category);
	const fmType = frontmatter.element_type;
	const genericType =
		opts.genericTargetType?.trim() ||
		(typeof fmType === "string" && fmType.trim() ? fmType.trim() : undefined);
	/** A link field's resolution target: `any` narrowed by element_type when the note carries one. */
	const targetOf = (field: SchemaField): string | undefined =>
		field.target === "any" && genericType ? normalizeCategory(genericType) : field.target;

	for (const [key, value] of Object.entries(frontmatter)) {
		if (NON_PAYLOAD_KEYS.has(key)) continue;
		if (key === bodyField) continue; // body owns this field; skip the fm copy
		if (isApiDroppedField(category, key)) continue; // a scaffold the API refuses: never sent, never adopted
		// A Date here was a string in the note that YAML read as a timestamp
		// (plain `2024-01-01`): it goes back as that string (row 3).
		if (isExtensionKey(key)) {
			out[key] = dateToFieldString(value); // verbatim, read-only
			continue;
		}
		if (!schema) {
			out[key] = dateToFieldString(value); // unknown category — pass through, API arbitrates
			continue;
		}
		const field = schema[key];
		if (!field) {
			// A key that is neither a schema field nor already namespaced. The API
			// REJECTS these outright ("Unknown field: x") — so historically we
			// dropped them here, silently, and the user's data never left the vault.
			//
			// Instead, adopt it as a custom field by prepending the extension
			// namespace: `mood` -> `x_mood`. The value rides verbatim (the API
			// accepts any JSON type in an x_ field — probed 2026-08-22: string,
			// number, list, bool and nested object all round-trip).
			//
			// Reported via opts.adopted so the caller can rename the key in the
			// note itself and tell the user; silent adoption would be its own
			// (smaller) surprise.
			const adoptedKey = `${EXTENSION_NAMESPACES[2]}${key}`;
			if (adoptedKey in frontmatter) continue; // x_mood already exists — that one wins
			out[adoptedKey] = dateToFieldString(value);
			opts.adopted?.push({ from: key, to: adoptedKey });
			continue;
		}
		if (field.type === "single_link") {
			// Normalize first (collapses stub objects / arrays / empties to a single
			// value), then resolve the wikilink-or-id to a bare id.
			const norm = normalizeLinkValue(value, "single_link");
			if (norm == null) { out[key] = null; continue; }
			const id = linkValueToId(norm, opts, targetOf(field));
			// A non-null input that resolved to null is unresolved. On the upload
			// path, OMIT the field rather than write null — a null single-link on a
			// full-field PATCH would clear the server's value.
			if (id == null && opts.omitFieldOnUnresolved) continue;
			out[key] = id;
		} else if (field.type === "multi_link") {
			const arr = normalizeLinkValue(value, "multi_link") as string[];
			const ids = arr
				.map((v) => linkValueToId(v, opts, targetOf(field)))
				.filter((v): v is string => v != null);
			// If any input entry didn't resolve, the list is SHORTENED — and a
			// full-field PATCH from a shortened list strips server links. Omit the
			// whole field instead so the server value wins (matches the span guard).
			if (ids.length < arr.length && opts.omitFieldOnUnresolved) continue;
			out[key] = ids;
		} else {
			out[key] = field.type === "text" ? textFieldString(value) : value;
		}
	}
	return out;
}

/**
 * Options for building frontmatter (R1 readability).
 *
 * `resolveIdToName` renders link ids as `[[Name]]` wikilinks (raw id kept when
 * the id has no local note — dangling/cross-world links are never lost). When
 * absent, link fields stay raw ids (today's behavior) so vault-less unit tests
 * still pass.
 */
export interface WriteFrontmatterOptions {
	resolveIdToName?: IdToName;
	/**
	 * Emit EVERY frontmatter field of the category, empty ones included, instead
	 * of only those with values (the R3 empty-omit rule). Set when creating a new
	 * element: the empty properties are the scaffold that makes the fields
	 * discoverable at all. Live-verified 2026-08-22 that Obsidian keeps empty
	 * frontmatter keys across an open/edit/close cycle, so the scaffold sticks.
	 *
	 * Downloads leave this off — a downloaded note shows what the element has.
	 */
	scaffoldEmptyFields?: boolean;
}

/**
 * Build the frontmatter object to persist for an element, given API data.
 *
 * Layout (R2/R4): `name` first, then real content fields in schema order, then
 * `image_url`, then `id` LAST — Obsidian renders Properties in object-key order,
 * so machine fields sink to the bottom and the readable fields lead. `name` and
 * `id` are always present.
 *
 * Link fields (R1): rendered as `[[Name]]` wikilinks when a resolver is given
 * (single_link -> one string, multi_link -> array of strings), else raw ids.
 *
 * Empty omit (R3): a field whose value is null / "" / [] is dropped — a note
 * carries only fields that have values. NEVER dropped: `id`, `name`, and
 * extension keys (atlas_/shadow_/x_ round-trip verbatim even when empty).
 *
 * The body-derived field (description/story) is excluded — it lives in the body.
 */
export function apiDataToFrontmatter(
	data: Record<string, unknown>,
	category: string,
	elementId: string,
	opts: WriteFrontmatterOptions = {}
): Record<string, unknown> {
	const schema = getCategorySchema(category);
	const bodyField = bodyFieldForCategory(category);
	const resolve = opts.resolveIdToName;

	// Collect content fields first, then assemble in R4 order at the end.
	const content: Record<string, unknown> = {};
	let imageUrl: unknown = undefined;

	for (const [key, value] of Object.entries(data)) {
		if (key === "id" || key === "name") continue;
		if (key === bodyField) continue; // description/story goes to the body
		if (key === "world" || key === "world_id") continue;
		if (isExtensionKey(key)) {
			content[key] = value; // verbatim, kept even when empty (R3 exception)
			continue;
		}
		if (!schema) {
			// Unknown category — pass through, but still apply the empty-omit rule.
			if (!isEmptyFieldValue(value)) content[key] = value;
			continue;
		}
		const field = schema[key];
		if (!field) {
			// Not a known field and not an extension key. Drop from frontmatter to
			// keep notes clean — the API would not have returned it anyway.
			continue;
		}
		// v3.2: TEXT fields live in the BODY as `## Heading` sections, never in
		// frontmatter — except the base identity keys, which §2 keeps up top.
		if (field.type === "text" && !BASE_FRONTMATTER_KEYS.has(key)) continue;
		let out: unknown;
		if (field.type === "single_link") {
			const norm = normalizeLinkValue(value, "single_link");
			out = typeof norm === "string" ? renderLinkId(norm, resolve) : null;
		} else if (field.type === "multi_link") {
			const arr = normalizeLinkValue(value, "multi_link") as string[];
			out = arr.map((id) => renderLinkId(id, resolve));
		} else {
			out = value;
		}
		if (isEmptyFieldValue(out)) continue; // R3 omit — but id/name/ext handled above
		if (key === "image_url") {
			imageUrl = out;
		} else {
			content[key] = out;
		}
	}

	// Scaffold mode: seed every non-text field of the category so a new element
	// shows its whole shape. Runs BEFORE assembly so ordering still applies.
	if (opts.scaffoldEmptyFields && schema) {
		for (const [key, def] of Object.entries(schema)) {
			if (key === "name" || key === "id" || key === bodyField) continue;
			if (def.type === "text" && !BASE_FRONTMATTER_KEYS.has(key)) continue; // body owns it
			if (key === "image_url") {
				if (imageUrl === undefined) imageUrl = "";
				continue;
			}
			if (key in content) continue; // a real value already won
			content[key] = def.type === "multi_link" ? [] : def.type === "number" ? null : "";
		}
	}

	// v3.2 assembly (§2 ordering ruling): BASE first (name, id, supertype,
	// subtype, image_url), then NUMBER fields, then LINK fields — each in schema
	// order. Numbers before links because numbers are one-line scalars that stay
	// compact while link lists grow, so the identity block stays readable at the
	// top of the Properties panel. Obsidian renders properties in key order, so
	// this assembly IS the panel layout.
	const fm: Record<string, unknown> = {};
	fm.name = typeof data.name === "string" ? data.name : "";
	fm.id = elementId;
	for (const k of ["supertype", "subtype"]) {
		if (k in content) fm[k] = content[k];
	}
	if (imageUrl !== undefined) fm.image_url = imageUrl;

	const schemaForOrder = schema ?? {};
	const rank = (key: string): number => {
		const t = schemaForOrder[key]?.type;
		if (t === "number") return 0;
		if (t === "single_link" || t === "multi_link") return 1;
		return 2; // extension keys and anything unschema'd trail the known fields
	};
	const remaining = Object.keys(content).filter((k) => k !== "supertype" && k !== "subtype");
	// Stable sort: within a rank, schema order (= insertion order of `content`).
	remaining
		.map((k, i) => ({ k, i, r: rank(k) }))
		.sort((a, b) => a.r - b.r || a.i - b.i)
		.forEach(({ k }) => {
			fm[k] = content[k];
		});
	return fm;
}

/**
 * Extract requested scalar keys from a raw `---` YAML frontmatter block WITHOUT
 * any YAML library — a dependency-free line scan. Used by the download resolver's
 * disk-scan fallback, which must NOT depend on Obsidian's metadataCache (its
 * cold-cache staleness mid-bulk-write is the S9 bug this fixes).
 *
 * Only top-level `key: value` scalar lines are read; a single layer of matching
 * surrounding quotes is stripped and its escapes read back (the serializer
 * quotes values with YAML-special chars, e.g. a name containing ': ' or ' #'). Nested/list/multiline values are ignored. Returns
 * only the keys in `keys` that were found with a non-empty value.
 */
export function parseRawFrontmatterScalars(
	content: string,
	keys: readonly string[]
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!content.startsWith("---")) return out;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return out;
	const block = content.slice(3, end);
	const wanted = new Set(keys);
	for (const line of block.split(/\r?\n/)) {
		const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
		if (!m || !wanted.has(m[1])) continue;
		let val = m[2].trim();
		if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
			// The escapes yamlDoubleQuoted writes, read back (row 3).
			val = val.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, e: string) => {
				if (e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
				return e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "0" ? "\0" : e;
			});
		} else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) {
			val = val.slice(1, -1).replace(/''/g, "'");
		}
		if (val) out[m[1]] = val;
	}
	return out;
}

/**
 * Read-before-PATCH diff (R7). Given the local payload we intend to write and
 * the current server element, return only the fields whose value actually
 * differs — so a save touches exactly what changed and leaves server-only
 * fields (including extension namespaces the note may not carry) untouched.
 *
 * `server` is the v2 element body (bare link ids, extension fields present).
 * Link values are compared order-insensitively for arrays. `name` is always
 * included when present in local (cheap, and it's the human-visible field).
 */
export function diffPayload(
	local: Record<string, unknown>,
	server: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(local)) {
		if (!valuesEqual(value, server[key])) {
			out[key] = value;
		}
	}
	return out;
}

function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null && b == null) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		// Link id arrays are sets; compare order-insensitively via sorted strings.
		const sa = [...a].map((x) => JSON.stringify(x)).sort();
		const sb = [...b].map((x) => JSON.stringify(x)).sort();
		return sa.every((v, i) => v === sb[i]);
	}
	if (typeof a === "object" && typeof b === "object" && a && b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Legacy span-format parsing (read tolerance + migration source, R1/R2).
//
// The span format encodes each field as a markdown list line:
//   - <span class="text-field"       data-tooltip="Text">Name</span>: value
//   - <span class="integer"          data-tooltip="Number">Height</span>: 3
//   - <span class="link-field"       data-tooltip="Single Location">Location</span>: [[Home]]
//   - <span class="multi-link-field" data-tooltip="Multi Trait">Traits</span>: [[Brave]], [[Bold]]
//
// Field type comes from the tooltip prefix (Text / Number / Single X / Multi X).
// Link VALUES are [[wikilinks]] to element notes by (sanitized) name — resolving
// them to ids needs the vault, so span parsing returns link fields as the raw
// [[name]] list; the caller resolves names -> ids via the world index.
// ---------------------------------------------------------------------------

export interface ParsedSpanField {
	/** snake_case field key, e.g. "location", "height", "str" */
	key: string;
	/** "text" | "number" | "single_link" | "multi_link" */
	kind: SchemaField["type"];
	/** raw value string after the colon (undecoded of wikilinks) */
	raw: string;
	/** for link kinds: the [[names]] extracted, in order */
	linkNames: string[];
}

export interface ParsedSpanNote {
	id: string | null;
	name: string | null;
	fields: ParsedSpanField[];
	/** true if any span markup was found (i.e. this really is span format) */
	isSpanFormat: boolean;
}

const SPAN_LINE = /^-\s*<span class="([^"]+)"\s+data-tooltip="([^"]+)">([^<]+)<\/span>:\s*(.*)$/;
const WIKILINK = /\[\[(.*?)\]\]/g;
// UUID_RE is declared near the top of the module (shared with the wikilink helpers).

const TTRPG_STATS = new Set(["STR", "DEX", "CON", "INT", "WIS", "CHA"]);

/** "Image url" -> "image_url", "Parent_map" -> "parent_map", "STR" -> "STR". */
export function spanLabelToKey(label: string): string {
	const letters = label.replace(/[^a-zA-Z]/g, "").toUpperCase();
	if (TTRPG_STATS.has(letters)) return letters;
	return label
		.trim()
		.replace(/([a-z])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[\s\-]+/g, "_")
		.replace(/_+/g, "_");
}

function tooltipKind(tooltip: string): SchemaField["type"] {
	const t = tooltip.trim().toLowerCase();
	if (t.startsWith("single ")) return "single_link";
	if (t.startsWith("multi ")) return "multi_link";
	if (t === "number") return "number";
	return "text";
}

function extractWikilinks(raw: string): string[] {
	const names: string[] = [];
	let m: RegExpExecArray | null;
	WIKILINK.lastIndex = 0;
	while ((m = WIKILINK.exec(raw)) !== null) {
		const n = m[1].trim();
		if (n) names.push(n);
	}
	return names;
}

/** Detect span format cheaply (used to decide read path / migration eligibility). */
export function isSpanFormat(content: string): boolean {
	return /<span class="(text-field|string|integer|link-field|multi-link-field)"/.test(content);
}

/**
 * Parse a legacy span-format note body into structured fields. Does NOT resolve
 * link names to ids (needs the vault) — link fields carry their [[names]].
 */
export function parseSpanNote(content: string): ParsedSpanNote {
	const lines = content.split(/\r?\n/);
	const fields: ParsedSpanField[] = [];
	let id: string | null = null;
	let name: string | null = null;
	let sawSpan = false;

	for (const line of lines) {
		const m = SPAN_LINE.exec(line.trim());
		if (!m) continue;
		sawSpan = true;
		const label = m[3].trim();
		const tooltip = m[2].trim();
		// Decode HTML entities: pre-2.2.2 notes were written through Handlebars'
		// default escaping, so "The Kid's Family" landed on disk as
		// "The Kid&#x27;s Family". Every text/name/link value must decode or the
		// escaped form migrates verbatim (the corruption this phase must not carry
		// forward). Matches SaveElementCommand/ExportWorldCommand's decode.
		const raw = decodeHtmlEntities(m[4].trim());
		const key = spanLabelToKey(label);

		if (key === "id") {
			id = raw.length ? raw : null;
			continue;
		}
		if (key === "name") {
			name = raw.length ? raw : null;
			// name is also a normal text field; fall through to record it
		}

		const kind = tooltipKind(tooltip);
		const linkNames =
			kind === "single_link" || kind === "multi_link" ? extractWikilinks(raw) : [];
		fields.push({ key, kind, raw, linkNames });
	}

	return { id, name, fields, isSpanFormat: sawSpan || isSpanFormat(content) };
}

/**
 * Convert parsed span fields into a frontmatter object + separated body value,
 * given a link-name -> id resolver. Returns:
 *   - frontmatter: { id, name, ...typed fields } (link fields as ids)
 *   - bodyValue:   the description/story text for the body (may be "")
 *
 * `resolveLink` maps a [[name]] (or a raw uuid) to an element id, or null if
 * unresolvable; unresolvable links are dropped from the id list but the caller
 * is told via `unresolved`.
 */
export function spanFieldsToFrontmatter(
	parsed: ParsedSpanNote,
	category: string,
	resolveLink: (nameOrId: string) => string | null
): { frontmatter: Record<string, unknown>; bodyValue: string; unresolved: string[] } {
	const bodyField = bodyFieldForCategory(category);
	const fm: Record<string, unknown> = {};
	if (parsed.id) fm.id = parsed.id;
	if (parsed.name) fm.name = parsed.name;
	let bodyValue = "";
	const unresolved: string[] = [];

	const resolveOne = (nameOrId: string): string | null => {
		if (UUID_RE.test(nameOrId)) return nameOrId; // already an id
		const resolved = resolveLink(nameOrId);
		if (!resolved) unresolved.push(nameOrId);
		return resolved;
	};

	for (const f of parsed.fields) {
		if (f.key === "id" || f.key === "name") continue;
		if (f.key === bodyField) {
			bodyValue = f.raw;
			continue;
		}
		const isEmpty = !f.raw || f.raw.toLowerCase() === "none";
		switch (f.kind) {
			case "single_link": {
				if (isEmpty || f.linkNames.length === 0) {
					fm[f.key] = null;
					break;
				}
				fm[f.key] = resolveOne(f.linkNames[0]);
				break;
			}
			case "multi_link": {
				const ids = f.linkNames
					.map(resolveOne)
					.filter((v): v is string => !!v);
				fm[f.key] = ids;
				break;
			}
			case "number": {
				if (isEmpty) {
					fm[f.key] = null;
					break;
				}
				const n = Number(f.raw);
				fm[f.key] = Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(f.raw) ? n : null;
				break;
			}
			default: {
				// text
				if (isEmpty) {
					fm[f.key] = null;
				} else {
					fm[f.key] = f.raw;
				}
			}
		}
	}

	return { frontmatter: fm, bodyValue, unresolved };
}
