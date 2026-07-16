import { App, TFile, normalizePath, parseYaml } from "obsidian";
import {
	frontmatterToPayloadFields,
	apiDataToFrontmatter,
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
		});
		if (unresolved.length > 0) {
			// Never silent (round-trip law): a `[[Name]]` link that resolves to no
			// note is dropped from the outbound id list, but we log which ones so the
			// loss is visible in the console rather than vanishing.
			console.warn(
				`[OnlyWorlds] ${file.path}: ${unresolved.length} unresolved link(s) dropped on read: ${unresolved.join(", ")}`
			);
		}
		const bodyField = bodyFieldForCategory(category);
		if (body) fields[bodyField] = body;
		if (!fields.name) {
			fields.name = typeof fm.name === "string" ? fm.name : file.basename;
		}
		return {
			id: fm.id,
			name: String(fields.name),
			category,
			worldName: pathInfo.worldName,
			fields,
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
	folderPath?: string; // e.g. "OnlyWorlds/Worlds/W/Elements/Character (12)"
	fileName?: string; // e.g. "Ireena (2).md"
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
	const safeName = name.replace(/[\\/:*?"<>|]/g, "-");
	const bodyField = bodyFieldForCategory(cat);
	const bodyValue = typeof data[bodyField] === "string" ? (data[bodyField] as string) : "";

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

	const fm = apiDataToFrontmatter(data, cat, elementId, {
		resolveIdToName: buildIdToNameResolver(app, worldName),
	});

	markSelfWrite?.(file.path);
	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		const target = frontmatter as Record<string, unknown>;
		// Rewrite the fields we own from scratch so their ORDER matches `fm`
		// (name first, image_url/id last — R4). Delete every owned key first
		// (including ones now empty/omitted — R3), then re-insert in fm order.
		// Extension keys and any user-added frontmatter NOT owned are left in place.
		const schema = getCategorySchema(cat);
		const ownedKeys = new Set<string>(["id", "name"]);
		if (schema) for (const k of Object.keys(schema)) ownedKeys.add(k);
		for (const k of Object.keys(target)) {
			if (ownedKeys.has(k)) delete target[k];
		}
		for (const [k, v] of Object.entries(fm)) {
			target[k] = v;
		}
	});

	// Write the body (description/story). processFrontMatter preserved the body,
	// so re-read, swap the body, keep the frontmatter block intact.
	const content = await app.vault.read(file);
	const fmBlock = extractFrontmatterBlock(content);
	const newContent = fmBlock ? `${fmBlock}\n${bodyValue}\n` : `${bodyValue}\n`;
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
