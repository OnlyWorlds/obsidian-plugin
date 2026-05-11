import { App, TFile, normalizePath } from "obsidian";
import { FIELD_SCHEMA } from "@onlyworlds/sdk";

/**
 * Element file format (v2 / frontmatter).
 *
 * Each element note has:
 *   - YAML frontmatter holding structured fields (id, name, supertype, plus
 *     element-type-specific fields per FIELD_SCHEMA).
 *   - Body containing the long-form description (markdown).
 *
 * The body is treated as the canonical `description` field. Other text fields
 * (physicality, mentality, etc.) live in frontmatter only.
 */

export interface ParsedElement {
	id: string;
	name: string;
	category: string; // lowercase singular, e.g. "character"
	worldName: string;
	fields: Record<string, unknown>; // snake_case, ready for SDK
}

/** Map a vault path to (worldName, category, ext). Returns null if not an element. */
export function parseElementPath(path: string): { worldName: string; category: string } | null {
	const m = /^OnlyWorlds\/Worlds\/([^/]+)\/Elements\/([^/]+)\/.+\.md$/i.exec(path);
	if (!m) return null;
	const rawCat = m[2];
	const baseCat = rawCat.replace(/\s*\(\d+\)$/, "");
	return { worldName: m[1], category: baseCat };
}

/** Lowercase, normalize a category string ("Character" -> "character"). */
export function normalizeCategory(category: string): string {
	return category.toLowerCase().trim();
}

/**
 * Schema-driven plural map used to derive SDK resource accessor name.
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
 * Read an element note via Obsidian's metadata cache (frontmatter) + vault (body).
 * Returns null if the file doesn't have an `id` field — likely not a v2 element note.
 */
export async function readElement(app: App, file: TFile): Promise<ParsedElement | null> {
	const pathInfo = parseElementPath(file.path);
	if (!pathInfo) return null;

	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	if (!fm || typeof fm.id !== "string") return null;

	const category = normalizeCategory(pathInfo.category);
	const schema = (FIELD_SCHEMA as Record<string, Record<string, { type: string }>>)[category];
	if (!schema) {
		// Unknown category — return basic data and let the API reject if invalid
		return {
			id: fm.id,
			name: typeof fm.name === "string" ? fm.name : file.basename,
			category,
			worldName: pathInfo.worldName,
			fields: stripMeta(fm),
		};
	}

	// Read the body (markdown after frontmatter) — used as the canonical `description`
	const content = await app.vault.read(file);
	const body = stripFrontmatter(content).trim();

	const fields: Record<string, unknown> = {};
	for (const key of Object.keys(schema)) {
		if (key in fm) {
			fields[key] = fm[key];
		}
	}
	// Body overrides description if present
	if (body) {
		fields.description = body;
	}
	// Ensure name is present (frontmatter or fallback to file basename)
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

/**
 * Write/update an element note in v2 format.
 * Atomic via processFrontMatter; body holds description.
 */
export async function writeElement(
	app: App,
	worldName: string,
	category: string,
	elementId: string,
	data: Record<string, unknown>
): Promise<TFile> {
	const cat = normalizeCategory(category);
	const folderName = capitalize(cat);
	const name = typeof data.name === "string" && data.name ? data.name : "Untitled";
	const safeName = name.replace(/[\\/:*?"<>|]/g, "-");
	const filePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements/${folderName}/${safeName}.md`);

	let file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) {
		// Ensure folder exists
		const folder = `OnlyWorlds/Worlds/${worldName}/Elements/${folderName}`;
		if (!app.vault.getAbstractFileByPath(folder)) {
			await app.vault.createFolder(folder);
		}
		const body = typeof data.description === "string" ? data.description : "";
		file = await app.vault.create(filePath, `---\nid: ${elementId}\nname: ${safeName}\n---\n\n${body}\n`);
	}
	if (!(file instanceof TFile)) throw new Error(`Failed to materialize element file at ${filePath}`);

	await app.fileManager.processFrontMatter(file, (frontmatter) => {
		const fm = frontmatter as Record<string, unknown>;
		fm.id = elementId;
		fm.name = name;
		const schema = (FIELD_SCHEMA as Record<string, Record<string, { type: string }>>)[cat];
		if (schema) {
			for (const key of Object.keys(schema)) {
				if (key === "description") continue; // body holds description
				if (key in data) {
					fm[key] = data[key];
				}
			}
		} else {
			for (const [k, v] of Object.entries(data)) {
				if (k === "description") continue;
				fm[k] = v;
			}
		}
	});

	if (typeof data.description === "string") {
		const content = await app.vault.read(file);
		const fmBlock = extractFrontmatterBlock(content);
		const newContent = `${fmBlock}\n${data.description.trim()}\n`;
		await app.vault.modify(file, newContent);
	}

	return file;
}

function stripMeta(fm: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...fm };
	delete out.id;
	delete out.world;
	delete out.world_id;
	return out;
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
