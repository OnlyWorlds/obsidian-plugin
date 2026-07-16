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

/** Meta keys that never belong in an outbound API payload. */
const NON_PAYLOAD_KEYS = new Set(["id", "world", "world_id", "position", "aliases", "tags"]);

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

export function getCategorySchema(category: string): CategorySchema | null {
	const cat = normalizeCategory(category);
	return (FIELD_SCHEMA as Record<string, CategorySchema>)[cat] ?? null;
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
export function frontmatterToPayloadFields(
	frontmatter: Record<string, unknown>,
	category: string
): Record<string, unknown> {
	const schema = getCategorySchema(category);
	const out: Record<string, unknown> = {};
	const bodyField = bodyFieldForCategory(category);

	for (const [key, value] of Object.entries(frontmatter)) {
		if (NON_PAYLOAD_KEYS.has(key)) continue;
		if (key === bodyField) continue; // body owns this field; skip the fm copy
		if (isExtensionKey(key)) {
			out[key] = value; // verbatim, read-only
			continue;
		}
		if (!schema) {
			out[key] = value; // unknown category — pass through, API arbitrates
			continue;
		}
		const field = schema[key];
		if (!field) continue; // unknown non-extension key on a known type — not an API field
		if (field.type === "single_link" || field.type === "multi_link") {
			out[key] = normalizeLinkValue(value, field.type);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/**
 * Build the frontmatter object to persist for an element, given API data.
 * Link fields are normalized to id shape (single string / multi array).
 * Extension keys in `data` are preserved verbatim. The body-derived field
 * (description/story) is excluded — it lives in the note body, not frontmatter.
 *
 * `id` and `name` are always placed first (callers rely on stable head keys).
 */
export function apiDataToFrontmatter(
	data: Record<string, unknown>,
	category: string,
	elementId: string
): Record<string, unknown> {
	const schema = getCategorySchema(category);
	const bodyField = bodyFieldForCategory(category);
	const fm: Record<string, unknown> = {};
	fm.id = elementId;
	if (typeof data.name === "string") fm.name = data.name;

	for (const [key, value] of Object.entries(data)) {
		if (key === "id" || key === "name") continue;
		if (key === bodyField) continue; // description/story goes to the body
		if (key === "world" || key === "world_id") continue;
		if (isExtensionKey(key)) {
			fm[key] = value; // verbatim
			continue;
		}
		if (!schema) {
			fm[key] = value;
			continue;
		}
		const field = schema[key];
		if (!field) {
			// Not a known field and not an extension key. Drop from frontmatter to
			// keep notes clean — but this branch only fires for genuinely foreign
			// non-namespaced keys, which the API would not have returned anyway.
			continue;
		}
		if (field.type === "single_link" || field.type === "multi_link") {
			fm[key] = normalizeLinkValue(value, field.type);
		} else {
			fm[key] = value;
		}
	}
	return fm;
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
