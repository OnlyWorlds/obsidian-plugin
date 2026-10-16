/**
 * OnlyWorlds Folder Format serializers — the Phase C folder bridge.
 *
 * PURE logic only: NO Obsidian imports (unit-tested under plain `node --test`,
 * like element-transform.ts). The Obsidian-facing wiring — vault walking, file
 * I/O, folder pickers, report modals — lives in Commands/{Export,Import}Folder-
 * Command.ts and calls into here.
 *
 * The format is the Track H "OnlyWorlds folder" standard (Atlas is the reference
 * implementation, Magelet the third; this makes the plugin the fourth). The four
 * live-proven Atlas-ingest conformance facts, transcribed faithfully from the
 * gold-standard writer (azgaar-converter/src/folder.js, live-tested against Atlas
 * 2026-07-14) — folder.js WINS on any disagreement (R1, disclosed in the report):
 *
 *   (a) world.json carries `id` + `name` (+ world meta).
 *   (b) all 22 types live under elements/<type>/, map/pin/zone/marker included
 *       (spec §4, ruled 2026-07-28; OW Infra #166 row 13). The import still
 *       reads the legacy spatial/<type>/ layout, which Atlas through v1.0 and
 *       this plugin through 3.3 wrote.
 *   (c) every element body carries in-file `type` (the FOLDER dialect only; it
 *       never rides the API/bulk). No timestamp is minted: server and sync
 *       fields an import carried are written back as received, nothing else
 *       (OW Infra #166 row 6, spec §4.1/§5).
 *   (d) folder name = <slug>-<first 8 chars of world id>; element files follow
 *       spec §3.2's RECOMMENDED profile (slugify, filenameFor,
 *       planElementPaths; OW Infra #166 row 14). Filename = presentation,
 *       id = identity: the import reads any filename (§3.1).
 *
 * ow:// mention scheme (R3): body prose carries element references as
 * `[Label](ow://<type>/<uuid>)`. On export a `[[WikiLink]]` becomes that form
 * when the name resolves to a known element; unresolvable stays a literal
 * `[[name]]`. On import the reverse; an ow:// whose uuid does not resolve is
 * KEPT VERBATIM (never destroy a reference).
 */
import { getCategorySchema, isExtensionKey } from "./element-transform";

/**
 * The four types the legacy `spatial/<type>/` layout held. Export no longer
 * writes there (spec §4: `elements/<type>/` for all 22); a reader SHOULD still
 * accept `spatial/{map,pin,zone,marker}/`, and the import does.
 */
export const SPATIAL_TYPES = new Set(["map", "pin", "zone", "marker"]);

/**
 * Keys of a folder element body that a note has no home for: anything that is
 * not `id`, `name` or `type`, not a schema field of the element's type and not
 * an extension key. In practice the server's and Atlas's own fields
 * (`created_at`, `updated_at`, `change_seq`, `created_by`, `local_updated_at`,
 * `server_updated_at`, `image_media_id`). The note would drop them (and must:
 * an upload must never send them), so the import keeps them in the folder
 * sidecar and the export writes them back as received (spec §4.1: a writer MUST
 * NOT drop data it has, MUST NOT synthesize a timestamp it does not have;
 * §4.2/§5: server fields kept as received). OW Infra #166 row 6.
 *
 * An unknown type (no schema) carries nothing here: the note passes every key
 * of an unknown type through as it is.
 */
export function splitCarriedFields(
	type: string,
	payload: Record<string, unknown>
): { payload: Record<string, unknown>; carried: Record<string, unknown> } {
	const schema = getCategorySchema(type);
	if (!schema) return { payload: { ...payload }, carried: {} };
	const kept: Record<string, unknown> = {};
	const carried: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (k === "id" || k === "name" || isExtensionKey(k) || k in schema) kept[k] = v;
		else carried[k] = v;
	}
	return { payload: kept, carried };
}

/** Spec §3.2: the slug is capped at 40 chars (trued to Atlas's SLUG_MAX_LEN). */
export const SLUG_MAX_LEN = 40;

/**
 * Slugify a name for filesystem use, spec §3.2's RECOMMENDED profile, the same
 * steps as Atlas's `slugify` (fs-utils.ts): NFKD, drop combining marks,
 * lowercase, non-alphanumeric runs to one `-`, trim `-`, then cut to the cap
 * and strip a trailing `-` (cut first, then strip: ruled 2026-09-28).
 */
export function slugify(name: string, max = SLUG_MAX_LEN): string {
	return String(name)
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // strip combining diacritics
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
}

/** 8-char id tail: strip dashes, take the last 8 chars (spec §3.2). */
export function idTail(id: string): string {
	return id.replace(/-/g, "").slice(-8);
}

/**
 * Element filename, spec §3.2: `<slug>--<tail>.json`; `fullId` gives the
 * collision fallback `<slug>--<full-id>.json` (Atlas's elementFilenameFullId).
 * An empty or unsluggable name is `<full-id>.json` either way.
 */
export function filenameFor(element: { id: string; name?: unknown }, fullId = false): string {
	const slug = slugify(typeof element.name === "string" ? element.name : "");
	if (!slug) return `${element.id}.json`;
	return `${slug}--${fullId ? element.id : idTail(element.id)}.json`;
}

/**
 * Folder name for a world: `<slug>-<first 8 chars of world id>` (R1d). The
 * spec leaves a world folder's name to the tool (presentation, §4 archives);
 * the cap stays at 60 so an existing export's folder keeps its name.
 */
export function worldFolderName(worldName: string, worldId: string): string {
	const head = worldId.replace(/-/g, "").slice(0, 8);
	const slug = slugify(worldName, 60);
	return slug ? `${slug}-${head}` : `world-${head}`;
}

/** Relative path (inside the world folder) for an element JSON file: elements/<type>/ for every type (spec §4). */
export function elementRelPath(type: string, element: { id: string; name?: unknown }, fullId = false): string {
	return `elements/${type}/${filenameFor(element, fullId)}`;
}

/**
 * Every element's relative path for one export, with spec §3.2's writer
 * collision rule (a MUST): two elements of one type whose short names coincide
 * (compared case-insensitively, as NTFS and APFS do) would share a file and the
 * second write would destroy the first. Ids go in ascending order; the first
 * keeps the short name and every later one falls back to the full id, so the
 * choice is the same on every run and in every writer (Atlas's open-time tidy
 * walks ids the same way). OW Infra #166 row 14.
 */
export function planElementPaths(
	elements: { type: string; id: string; name?: unknown }[]
): Map<string, string> {
	const byType = new Map<string, { type: string; id: string; name?: unknown }[]>();
	for (const el of elements) {
		const list = byType.get(el.type) ?? [];
		list.push(el);
		byType.set(el.type, list);
	}
	const out = new Map<string, string>();
	for (const [type, list] of byType) {
		const occupied = new Set<string>();
		for (const el of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
			let rel = elementRelPath(type, el);
			if (occupied.has(rel.toLowerCase())) rel = elementRelPath(type, el, true);
			occupied.add(rel.toLowerCase());
			out.set(el.id, rel);
		}
	}
	return out;
}

// --- ow:// <-> wikilink prose translation (R3) --------------------------------

const WIKILINK_RE = /\[\[([^\]]+?)\]\]/g;
// [Label](ow://type/uuid) — label may contain anything but a closing bracket.
const OW_MENTION_RE = /\[([^\]]*)\]\(ow:\/\/([a-z_]+)\/([0-9a-fA-F-]{36})\)/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An element as seen by prose translation: enough to build/resolve a mention. */
export interface ElementRef {
	id: string;
	name: string;
	type: string; // lowercase singular
}

/**
 * EXPORT prose: `[[Name]]` -> `[Name](ow://<type>/<uuid>)` when the name resolves
 * to a known element; an unresolved `[[name]]` is left as a literal (never
 * fabricate a reference). A wikilink of the `[[Name|Alias]]` form keeps Alias as
 * the visible label and resolves on Name.
 */
export function wikilinksToOwMentions(
	body: string,
	resolveName: (name: string) => ElementRef | null
): string {
	return body.replace(WIKILINK_RE, (whole, inner: string) => {
		const [target, alias] = inner.split("|").map((s) => s.trim());
		const ref = resolveName(target);
		if (!ref) return whole; // unresolvable — keep literal [[...]]
		const label = alias || ref.name;
		return `[${label}](ow://${ref.type}/${ref.id})`;
	});
}

/**
 * IMPORT prose: `[Label](ow://type/uuid)` -> `[[Name]]` when the uuid resolves to
 * a known element; an unresolved mention is KEPT VERBATIM (R3 — never destroy a
 * reference). When the resolved name differs from the label, an alias is kept so
 * the visible text is preserved: `[[Name|Label]]`.
 */
export function owMentionsToWikilinks(
	body: string,
	resolveId: (id: string) => ElementRef | null
): string {
	return body.replace(OW_MENTION_RE, (whole, label: string, _type: string, id: string) => {
		const ref = resolveId(id);
		if (!ref) return whole; // unresolvable — keep the ow:// form verbatim
		const trimmedLabel = label.trim();
		return trimmedLabel && trimmedLabel !== ref.name
			? `[[${ref.name}|${trimmedLabel}]]`
			: `[[${ref.name}]]`;
	});
}

// --- element body <-> folder JSON --------------------------------------------

/**
 * Build an element's folder-dialect JSON body from its API-shaped payload.
 *
 * `payload` is API-shaped (snake_case fields, links as ids, extension keys
 * present, body-field description/story included). `type` leads and always
 * reflects the true element type; any stray `type` in the payload is
 * overwritten. `carried` is what an import kept for this element
 * (splitCarriedFields), written back after the payload as received. `order`
 * is the source file's key order, when the element came from a folder.
 *
 * No timestamp is minted (spec §4.1: a writer MUST NOT synthesize
 * `local_updated_at`/`created_at` it does not have; §5: new files carry
 * neither sync stamp). OW Infra #166 row 6.
 */
export function buildFolderElementBody(
	type: string,
	payload: Record<string, unknown>,
	carried: Record<string, unknown> = {},
	order?: string[]
): Record<string, unknown> {
	const { type: _stray, ...rest } = payload;
	const body: Record<string, unknown> = { type, ...rest };
	for (const [k, v] of Object.entries(carried)) {
		if (k === "type" || k in body) continue; // the note's own value wins
		body[k] = v;
	}
	if (!order) return body;
	// Key order as received (spec §5): the source file's keys in its order,
	// then any key it did not have, in the plugin's order (Kael's review).
	const ordered: Record<string, unknown> = {};
	for (const k of order) if (k in body) ordered[k] = body[k];
	for (const [k, v] of Object.entries(body)) if (!(k in ordered)) ordered[k] = v;
	return ordered;
}

/**
 * Parse a folder-dialect element JSON body into (type, API-shaped payload,
 * carried). The `type` field is lifted out and returned separately; if absent,
 * `fallbackType` (derived from the containing elements/<type> or legacy
 * spatial/<type> folder) is used. What the note has no home for is split off
 * as `carried` (splitCarriedFields) for the import to keep.
 *
 * Extension keys and every schema field (including description/story) stay in
 * the payload verbatim (R4); the frontmatter writer arbitrates downstream.
 */
export function parseFolderElementBody(
	json: Record<string, unknown>,
	fallbackType: string
): { type: string; payload: Record<string, unknown>; carried: Record<string, unknown> } {
	const { type, ...rest } = json;
	const resolvedType =
		typeof type === "string" && type.trim() ? type.trim().toLowerCase() : fallbackType;
	const { payload, carried } = splitCarriedFields(resolvedType, rest);
	return { type: resolvedType, payload, carried };
}

/** Is this a valid UUID string (used to validate world.json / mention ids). */
export function isUuid(s: unknown): s is string {
	return typeof s === "string" && UUID_RE.test(s);
}
