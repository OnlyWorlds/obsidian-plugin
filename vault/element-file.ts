import { App, TFile, normalizePath, parseYaml } from "obsidian";
import { sanitizeFileName } from "../Scripts/WorldService";
import {
	frontmatterToPayloadFields,
	apiDataToFrontmatter,
	buildElementBody,
	bodyToFieldValues,
	parseElementBody,
	headingToFieldKey,
	isExtensionKey,
	splitNote,
	joinNote,
	serializeFrontmatter,
	bodyFieldForCategory,
	normalizeCategory,
	getCategorySchema,
	isSpanFormat,
	parseSpanNote,
	spanFieldsToFrontmatter,
} from "./element-transform";

/**
 * Element file format (v2 / frontmatter).
 *
 * Each element note has:
 *   - YAML frontmatter holding structured fields (id, name, plus element-type
 *     fields per FIELD_SCHEMA) AND any extension-namespaced keys
 *     (atlas_, shadow_, x_ prefixes) preserved verbatim.
 *   - Body containing the long-form text: `description` for all types EXCEPT
 *     Narrative, where the body is `story` (R5).
 *
 * This module is the Obsidian-facing wiring; the pure serialization logic lives
 * in element-transform.ts (unit-tested under `npm test`).
 *
 * READ tolerance: a note not yet migrated (still in the legacy <span> body
 * format) is parsed by the span reader so it is never data loss (R1). New
 * writes are always frontmatter.
 */

export interface ParsedElement {
	id: string;
	name: string;
	category: string; // lowercase singular, e.g. "character"
	worldName: string;
	fields: Record<string, unknown>; // snake_case, ready for the v2 payload builder
	/**
	 * `[[Name]]` link targets that resolved to no local note, so their whole
	 * field was omitted to protect the server's copy. The CALLER must surface
	 * these: a console warning is invisible, and the user sees "saved" while a
	 * link they just made silently did not travel. Typically a link to an
	 * element created locally and not yet uploaded.
	 */
	unresolvedLinks: string[];
}

/** Map a vault path to (worldName, category). Returns null if not an element. */
export function parseElementPath(path: string): { worldName: string; category: string } | null {
	const m = /^OnlyWorlds\/Worlds\/([^/]+)\/Elements\/([^/]+)\/.+\.md$/i.exec(path);
	if (!m) return null;
	const rawCat = m[2];
	const baseCat = rawCat.replace(/\s*\(\d+\)$/, "");
	return { worldName: m[1], category: baseCat };
}

export { normalizeCategory };

/**
 * Schema-driven plural map used to derive SDK/v2 resource accessor name.
 * (Character -> characters, Species -> species, etc.)
 */
const PLURAL_OVERRIDES: Record<string, string> = {
	ability: "abilities",
	family: "families",
	phenomenon: "phenomena",
	species: "species",
};

export function categoryToResourceKey(category: string): string {
	const cat = normalizeCategory(category);
	return PLURAL_OVERRIDES[cat] ?? `${cat}s`;
}

/**
 * Read an element note. Prefers frontmatter (v2); falls back to the legacy span
 * body format so pre-migration notes still round-trip (R1). Returns null if the
 * note carries no recoverable id.
 *
 * Extension-namespaced frontmatter keys (atlas_/shadow_/x_) are preserved into
 * `fields` verbatim (R3). The body becomes description (or story for Narrative).
 *
 * Note: reliable frontmatter needs metadataCache to have indexed the file. When
 * a caller writes then immediately re-reads, the cache may lag; we fall back to
 * parsing the raw YAML block so reads are not cache-timing-dependent.
 */
export async function readElement(app: App, file: TFile): Promise<ParsedElement | null> {
	const pathInfo = parseElementPath(file.path);
	if (!pathInfo) return null;
	const category = normalizeCategory(pathInfo.category);
	const content = await app.vault.read(file);

	// Frontmatter path: cache first, raw YAML fallback (cache-timing safety).
	let fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
	if (!fm || typeof fm.id !== "string") {
		const raw = parseRawFrontmatter(content);
		if (raw && typeof raw.id === "string") fm = raw;
	}

	if (fm && typeof fm.id === "string") {
		const body = stripFrontmatter(content).trim();
		// Link fields may be readable `[[Name]]` wikilinks (R1). Resolve them to
		// ids path-awarely (getFirstLinkpathDest disambiguates same-name notes).
		// A bare-id link value passes through untouched (dangling/unmigrated).
		const unresolved: string[] = [];
		const fields = frontmatterToPayloadFields(fm, category, {
			resolveNameToId: buildWikilinkResolver(app, file.path),
			unresolved,
			// Upload safety: a field with any unresolvable [[Name]] is OMITTED, not
			// shortened — a full-field bulk PATCH built from a reduced id list would
			// strip the server's copy of the dropped link (the 2.3.0 smoke class,
			// audit finding 2026-07-17). The server value wins until the link
			// resolves locally.
			omitFieldOnUnresolved: true,
		});
		if (unresolved.length > 0) {
			// Never silent (round-trip law): a `[[Name]]` link that resolves to no
			// note is dropped from THIS read's field set (the field is omitted so the
			// server value is preserved), logged so the loss is visible.
			console.warn(
				`[OnlyWorlds] ${file.path}: ${unresolved.length} unresolved link(s); their fields omitted from upload to preserve server values: ${unresolved.join(", ")}`
			);
		}
		// v3.2: the body carries text fields as `## Heading` sections. Unknown
		// headings and any preamble are folded back into description/story rather
		// than dropped (never-drop, R2) — a user who renames a heading loses no
		// prose. A legacy body with no headings at all parses to a lone preamble,
		// which lands in the body field exactly as it did before.
		if (body) {
			// A `## Looks` section is a user-added custom TEXT field and must reach
			// the API as `x_looks`, not be salvaged into description. We cannot know
			// from the note alone which unknown headings are deliberate, so treat
			// every unknown heading whose name is a clean single token as a custom
			// field. A heading with punctuation or many words reads as prose
			// structure and still falls through to the never-drop salvage.
			const customKeys = parseElementBody(body, category)
				.unknown.map((u) => u.heading.trim())
				.filter((h) => /^[A-Za-z][A-Za-z0-9 _-]{0,40}$/.test(h) && h.split(/\s+/).length <= 3)
				.map((h) => `x_${headingToFieldKey(h)}`);
			const sectionValues = bodyToFieldValues(body, category, customKeys);
			for (const [k, v] of Object.entries(sectionValues)) {
				fields[k] = v;
			}
		}
		if (!fields.name) {
			fields.name = typeof fm.name === "string" ? fm.name : file.basename;
		}
		return {
			id: fm.id,
			name: String(fields.name),
			category,
			worldName: pathInfo.worldName,
			fields,
			unresolvedLinks: unresolved,
		};
	}

	// Legacy span-format fallback (pre-migration notes).
	if (isSpanFormat(content)) {
		const parsed = parseSpanNote(content);
		if (!parsed.id) return null;
		const resolver = buildVaultLinkResolver(app, pathInfo.worldName);
		const { frontmatter, bodyValue } = spanFieldsToFrontmatter(parsed, category, resolver);
		const fields = frontmatterToPayloadFields(frontmatter, category);
		const bodyField = bodyFieldForCategory(category);
		if (bodyValue) fields[bodyField] = bodyValue;
		if (!fields.name) fields.name = parsed.name ?? file.basename;
		return {
			id: parsed.id,
			name: String(fields.name),
			category,
			worldName: pathInfo.worldName,
			fields,
			unresolvedLinks: [],
		};
	}

	return null;
}

/**
 * Write/update an element note in v2 frontmatter format.
 *
 * `data` is API-shaped (snake_case fields, link fields as ids). Extension keys
 * in `data` round-trip verbatim (R3). The body holds description/story (R5).
 * Atomic frontmatter via processFrontMatter; body written separately.
 *
 * Returns the file. `markSelfWrite` (if provided) is called with the path before
 * each disk write so the auto-sync modify listener skips our own writes.
 *
 * `opts.folderPath` lets a caller pass a pre-resolved category folder (which in
 * a real world carries a count suffix, e.g. "Character (12)") so writes don't
 * split off a bare "Character" folder. `opts.fileName` overrides the leaf name
 * (used for collision-suffixed unique names). Both are optional; without them
 * writeElement targets the bare-named folder / sanitized element name.
 */
export interface WriteElementOpts {
	markSelfWrite?: (path: string) => void;
	/**
	 * Write the element's FULL field set, empty fields included (v3.2 scaffold).
	 * Set by element CREATION so a new note shows every field it can carry;
	 * downloads leave it off so a note shows what the element actually has.
	 */
	scaffoldEmptyFields?: boolean;
	folderPath?: string; // e.g. "OnlyWorlds/Worlds/W/Elements/Character (12)"
	fileName?: string; // e.g. "Ireena (2).md"
	/**
	 * Pre-built id -> display-name resolver (R1). When present, link ids render as
	 * `[[Name]]` wikilinks against THIS map instead of the metadataCache-scanning
	 * buildIdToNameResolver. A caller mid-bulk-write (DownloadWorldCommand) supplies
	 * a map built from the in-memory payload (+ raw-disk fallback) because the cache
	 * is cold for freshly-written sibling notes — that stale cache is the S9 bug.
	 * Absent -> today's buildIdToNameResolver behavior (back-compat for Create/Import).
	 */
	idToName?: (id: string) => string | null;
}

export async function writeElement(
	app: App,
	worldName: string,
	category: string,
	elementId: string,
	data: Record<string, unknown>,
	optsOrMark?: WriteElementOpts | ((path: string) => void)
): Promise<TFile> {
	// Back-compat: a bare function arg is markSelfWrite.
	const opts: WriteElementOpts =
		typeof optsOrMark === "function" ? { markSelfWrite: optsOrMark } : optsOrMark ?? {};
	const markSelfWrite = opts.markSelfWrite;
	const cat = normalizeCategory(category);
	const folderName = capitalize(cat);
	const name = typeof data.name === "string" && data.name ? data.name : "Untitled";
	// MUST be the SAME transform DownloadWorldCommand.buildIdToNameMap applies to
	// wikilink targets — otherwise a name with a trailing dot/control char names
	// the file one way and the [[link]] another, and the link dangles (gate
	// finding, 2026-07-16: safeName was a weaker regex than sanitizeFileName).
	const safeName = sanitizeFileName(name);
	const bodyField = bodyFieldForCategory(cat);
	// v3.2: the body is no longer just description/story — it carries EVERY text
	// field as a `## Heading` section, empty ones included (the empty section is
	// the scaffold that makes a field discoverable at all). Custom `x_` text
	// fields ride along, rendered without their prefix.
	const customTextFields = Object.entries(data)
		.filter(([k, v]) => isExtensionKey(k) && typeof v === "string")
		.map(([k]) => k);
	const bodyValue = buildElementBody(data, cat, customTextFields);

	const folder = opts.folderPath
		? normalizePath(opts.folderPath)
		: `OnlyWorlds/Worlds/${worldName}/Elements/${folderName}`;
	const leaf = opts.fileName ? opts.fileName.replace(/\.md$/i, "") + ".md" : `${safeName}.md`;

	// Resolve target path: reuse an existing note with this id if present (so a
	// rename on the server moves the file rather than orphaning it).
	let filePath = normalizePath(`${folder}/${leaf}`);
	const existing = await findNoteById(app, worldName, folderName, elementId);
	if (existing && existing.path !== filePath) {
		filePath = existing.path; // keep the existing file; rename is a separate concern
	}

	let file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) {
		if (!app.vault.getAbstractFileByPath(folder)) {
			await app.vault.createFolder(folder);
		}
		markSelfWrite?.(filePath);
		file = await app.vault.create(filePath, `---\nid: ${elementId}\n---\n\n`);
	}
	if (!(file instanceof TFile)) throw new Error(`Failed to materialize element file at ${filePath}`);

	// R1: render link ids as [[Name]] wikilinks. Prefer a caller-supplied map
	// (payload-derived, cache-independent — the S9 fix) over the cache-scanning
	// resolver, which is unreliable mid-bulk-write (freshly-written siblings are
	// not yet indexed in metadataCache).
	const fm = apiDataToFrontmatter(data, cat, elementId, {
		resolveIdToName: opts.idToName ?? buildIdToNameResolver(app, worldName),
		scaffoldEmptyFields: opts.scaffoldEmptyFields,
	});

	// ★ ONE write for the whole note — frontmatter AND body together.
	//
	// This used to be two steps: processFrontMatter for the block, then a
	// vault.modify for the body. That is what corrupted notes (2026-08-22,
	// reproduced on four real notes): processFrontMatter is async and owns the
	// serialization, and on a note whose body was empty it left blank lines
	// above the `---`. A block that is not at byte 0 is not frontmatter to
	// Obsidian — the note renders as plain text and every later write buries it
	// deeper. Chasing it with a repair pass afterwards kept losing the race.
	//
	// Serializing the block ourselves removes the whole class: there is exactly
	// one write, it is built by joinNote, and joinNote cannot emit a leading
	// blank line. We also keep any frontmatter key we do not own (extension
	// namespaces, the user's own additions), which is what processFrontMatter
	// was buying us.
	const content = await app.vault.read(file);
	const existingFm = parseRawFrontmatter(content) ?? {};
	const schema = getCategorySchema(cat);
	const ownedKeys = new Set<string>(["id", "name"]);
	if (schema) for (const k of Object.keys(schema)) ownedKeys.add(k);
	const preserved: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(existingFm)) {
		if (!ownedKeys.has(k)) preserved[k] = v;
	}
	const merged: Record<string, unknown> = { ...fm };
	for (const [k, v] of Object.entries(preserved)) {
		if (!(k in merged)) merged[k] = v;
	}
	const newContent = joinNote(serializeFrontmatter(merged), `${bodyValue}\n`);
	if (newContent !== content) {
		markSelfWrite?.(file.path);
		await app.vault.modify(file, newContent);
	}

	return file;
}

// --- helpers -----------------------------------------------------------------

/** Parse a raw `---\n...\n---` YAML block (cache-independent read fallback). */
function parseRawFrontmatter(content: string): Record<string, unknown> | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return null;
	const yaml = content.slice(3, end + 1);
	try {
		const parsed = parseYaml(yaml);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Find an element note by embedded frontmatter id within a category folder. */
async function findNoteById(
	app: App,
	worldName: string,
	folderName: string,
	id: string
): Promise<TFile | null> {
	const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/${folderName}`;
	const files = app.vault
		.getMarkdownFiles()
		.filter((f) => f.path.startsWith(prefix + "/") || f.path.startsWith(prefix + " ("));
	for (const f of files) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm && fm.id === id) return f;
	}
	return null;
}

/**
 * Build a link-name -> id resolver over the vault's notes for a world. Reads
 * frontmatter id (falling back to a span id scrape for unmigrated notes).
 * Used when reading a legacy span note whose links are [[names]].
 */
function buildVaultLinkResolver(app: App, worldName: string): (name: string) => string | null {
	const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
	const index = new Map<string, string>();
	const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
	for (const f of files) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm && typeof fm.id === "string" && typeof fm.name === "string") {
			index.set(fm.name, fm.id);
			index.set(f.basename, fm.id);
		}
	}
	return (name: string) => index.get(name) ?? null;
}

/**
 * Build an id -> display-name resolver over a world's element notes (the INVERSE
 * of buildVaultLinkResolver). Used on WRITE to render link ids as `[[Name]]`
 * wikilinks (R1). An id with no local note returns null, so the raw id is kept
 * (dangling/cross-world links never lost).
 */
function buildIdToNameResolver(app: App, worldName: string): (id: string) => string | null {
	const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
	const index = new Map<string, string>();
	const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
	for (const f of files) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm && typeof fm.id === "string") {
			const name = typeof fm.name === "string" && fm.name ? fm.name : f.basename;
			index.set(fm.id, name);
		}
	}
	return (id: string) => index.get(id) ?? null;
}

/**
 * Build a path-aware `[[Name]]` -> id resolver for READ (R1). Uses Obsidian's
 * own link resolution (getFirstLinkpathDest) from the SOURCE note's path, so a
 * link to "Ireena" resolves the same way Obsidian's graph would — same-name
 * notes disambiguate by proximity, exactly as the probe proved. The target
 * file's frontmatter `id` is the resolved value; a target with no id (or no
 * target) yields null (reported unresolved, never guessed).
 */
function buildWikilinkResolver(app: App, sourcePath: string): (name: string) => string | null {
	return (name: string) => {
		const dest = app.metadataCache.getFirstLinkpathDest(name, sourcePath);
		if (!dest) return null;
		const fm = app.metadataCache.getFileCache(dest)?.frontmatter;
		return fm && typeof fm.id === "string" ? fm.id : null;
	};
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return content;
	return content.slice(end + 4);
}

function extractFrontmatterBlock(content: string): string {
	if (!content.startsWith("---")) return "";
	const end = content.indexOf("\n---", 3);
	if (end < 0) return "";
	return content.slice(0, end + 4);
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
