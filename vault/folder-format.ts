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
 *   (b) spatial types (map/pin/zone/marker) live under spatial/<type>/, all
 *       others under elements/<type>/.
 *   (c) every element body carries in-file `type` (the FOLDER dialect only; it
 *       never rides the API/bulk). No timestamp is minted: server and sync
 *       fields an import carried are written back as received, nothing else
 *       (OW Infra #166 row 6, spec §4.1/§5).
 *   (d) folder name = <slug>-<first 8 chars of world id>; element files =
 *       <slug>--<8-char id tail>.json (filename = presentation, id = identity).
 *
 * ow:// mention scheme (R3): body prose carries element references as
 * `[Label](ow://<type>/<uuid>)`. On export a `[[WikiLink]]` becomes that form
 * when the name resolves to a known element; unresolvable stays a literal
 * `[[name]]`. On import the reverse; an ow:// whose uuid does not resolve is
 * KEPT VERBATIM (never destroy a reference).
 */
import { getCategorySchema, isExtensionKey } from "./element-transform";

/**
 * Spatial types — copied verbatim from folder.js SPATIAL_TYPES. Atlas's reader
 * only indexes these under spatial/; everything else under elements/.
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

/**
 * Slugify a name for filesystem use — transcribed from folder.js `slugify` so
 * the plugin's filenames match the gold-standard writer byte-for-byte.
 */
export function slugify(name: string, max = 60): string {
	return String(name)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // strip combining diacritics
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
}

/** 8-char id tail: strip dashes, take the last 8 chars (folder.js filenameFor). */
export function idTail(id: string): string {
	return id.replace(/-/g, "").slice(-8);
}

/** Element filename: `<slug>--<tail>.json`, or `<type>--<tail>.json` if no name. */
export function filenameFor(type: string, element: { id: string; name?: unknown }): string {
	const tail = idTail(element.id);
	const slug = slugify(typeof element.name === "string" ? element.name : "");
	return slug ? `${slug}--${tail}.json` : `${type}--${tail}.json`;
}

/** Folder name for a world: `<slug>-<first 8 chars of world id>` (R1d). */
export function worldFolderName(worldName: string, worldId: string): string {
	const head = worldId.replace(/-/g, "").slice(0, 8);
	const slug = slugify(worldName);
	return slug ? `${slug}-${head}` : `world-${head}`;
}

/** Relative path (inside the world folder) for an element JSON file. */
export function elementRelPath(type: string, element: { id: string; name?: unknown }): string {
	const bucket = SPATIAL_TYPES.has(type) ? "spatial" : "elements";
	return `${bucket}/${type}/${filenameFor(type, element)}`;
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
 * (splitCarriedFields), written back after the payload as received.
 *
 * No timestamp is minted (spec §4.1: a writer MUST NOT synthesize
 * `local_updated_at`/`created_at` it does not have; §5: new files carry
 * neither sync stamp). OW Infra #166 row 6.
 */
export function buildFolderElementBody(
	type: string,
	payload: Record<string, unknown>,
	carried: Record<string, unknown> = {}
): Record<string, unknown> {
	const { type: _stray, ...rest } = payload;
	const body: Record<string, unknown> = { type, ...rest };
	for (const [k, v] of Object.entries(carried)) {
		if (k === "type" || k in body) continue; // the note's own value wins
		body[k] = v;
	}
	return body;
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
