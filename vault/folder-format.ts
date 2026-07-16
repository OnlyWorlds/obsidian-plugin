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
 *   (c) every element body carries in-file `type`, `local_updated_at`,
 *       `created_at` — the FOLDER dialect only; these never ride the API/bulk.
 *   (d) folder name = <slug>-<first 8 chars of world id>; element files =
 *       <slug>--<8-char id tail>.json (filename = presentation, id = identity).
 *
 * ow:// mention scheme (R3): body prose carries element references as
 * `[Label](ow://<type>/<uuid>)`. On export a `[[WikiLink]]` becomes that form
 * when the name resolves to a known element; unresolvable stays a literal
 * `[[name]]`. On import the reverse; an ow:// whose uuid does not resolve is
 * KEPT VERBATIM (never destroy a reference).
 */

/**
 * Spatial types — copied verbatim from folder.js SPATIAL_TYPES. Atlas's reader
 * only indexes these under spatial/; everything else under elements/.
 */
export const SPATIAL_TYPES = new Set(["map", "pin", "zone", "marker"]);

/**
 * The three fields the folder dialect stamps into every element body that the
 * API dialect does NOT carry (folder.js: without `type` in the body Atlas shows
 * an empty world). Stamped on the folder-write path only.
 */
export const FOLDER_BODY_STAMP_KEYS = ["type", "local_updated_at", "created_at"] as const;

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
 * present, body-field description/story included). The stamp keys (type,
 * local_updated_at, created_at) are added here — folder dialect only (R1c).
 * `type` always reflects the true element type; any stray `type` in the payload
 * is overwritten. The three stamp keys lead the object (folder.js order).
 *
 * The payload is otherwise passed through verbatim so extension namespaces
 * round-trip (R4) and `story`/`description` land as fields, not lost prose.
 */
export function buildFolderElementBody(
	type: string,
	payload: Record<string, unknown>,
	stamp: string
): Record<string, unknown> {
	const { type: _stray, local_updated_at: lu, created_at: ca, ...rest } = payload;
	return {
		type,
		local_updated_at: typeof lu === "string" ? lu : stamp,
		created_at: typeof ca === "string" ? ca : stamp,
		...rest,
	};
}

/**
 * Parse a folder-dialect element JSON body into (type, API-shaped payload).
 * Strips the three folder-only stamp keys so what remains is what the plugin's
 * writeElement/frontmatter path expects. The `type` field (folder-only) is
 * lifted out and returned separately; if absent, `fallbackType` (derived from
 * the containing spatial/<type> or elements/<type> folder) is used.
 *
 * Extension keys and every schema field (including description/story) survive
 * verbatim (R4) — this function does no field filtering; the frontmatter writer
 * arbitrates fields downstream.
 */
export function parseFolderElementBody(
	json: Record<string, unknown>,
	fallbackType: string
): { type: string; payload: Record<string, unknown> } {
	const { type, local_updated_at: _lu, created_at: _ca, ...payload } = json;
	const resolvedType =
		typeof type === "string" && type.trim() ? type.trim().toLowerCase() : fallbackType;
	return { type: resolvedType, payload };
}

/** Is this a valid UUID string (used to validate world.json / mention ids). */
export function isUuid(s: unknown): s is string {
	return typeof s === "string" && UUID_RE.test(s);
}
