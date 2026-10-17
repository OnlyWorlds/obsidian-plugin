import { App, TFile, normalizePath } from "obsidian";
import { AMBIGUOUS_LINK, getCategorySchema, normalizeCategory, wikilinkTarget } from "./element-transform";
import { buildWikilinkResolver, parseElementPath, parseRawFrontmatter } from "./element-file";
import type { CanvasRef, RelationshipGraph } from "./relationship-canvas";

/**
 * Reading one element's relationships out of the vault, for the canvas
 * (vault/relationship-canvas.ts draws them). The world's element notes are
 * read once: their ids, types and link fields. A link value resolves the way
 * the plugin's upload does (buildWikilinkResolver: `[[Name]]` by the field's
 * target type, path-aware), or as a raw id; one that finds no note in the
 * world stays a text node.
 */

interface Entry {
	file: TFile;
	id: string;
	category: string;
	fm: Record<string, unknown>;
}

interface WorldIndex {
	byPath: Map<string, Entry>;
	byId: Map<string, Entry>;
}

interface Link {
	field: string;
	value: string;
	target?: string;
}

async function frontmatterOf(app: App, file: TFile): Promise<Record<string, unknown> | null> {
	const cached = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
	if (cached && typeof cached.id === "string") return cached;
	return parseRawFrontmatter(await app.vault.read(file));
}

async function indexWorld(app: App, worldName: string): Promise<WorldIndex> {
	const root = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements`) + "/";
	const byPath = new Map<string, Entry>();
	const byId = new Map<string, Entry>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(root)) continue;
		const info = parseElementPath(file.path);
		if (!info) continue;
		const fm = await frontmatterOf(app, file);
		if (!fm || typeof fm.id !== "string") continue;
		const entry = { file, id: fm.id, category: normalizeCategory(info.category), fm };
		byPath.set(file.path, entry);
		if (!byId.has(fm.id)) byId.set(fm.id, entry);
	}
	return { byPath, byId };
}

/** Every value of every single- and multi-link field the note's type carries, in schema order. */
function linksOf(entry: Entry): Link[] {
	const schema = getCategorySchema(entry.category);
	if (!schema) return [];
	const out: Link[] = [];
	for (const [field, f] of Object.entries(schema)) {
		if (f.type !== "single_link" && f.type !== "multi_link") continue;
		const raw = entry.fm[field];
		const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
		for (const v of values) {
			if (typeof v !== "string" || !v.trim()) continue;
			const t = v.trim();
			// A legacy comma-joined id list; a wikilink keeps its commas.
			const parts = wikilinkTarget(t) == null && t.includes(",") ? t.split(",").map((s) => s.trim()).filter(Boolean) : [t];
			for (const p of parts) out.push({ field, value: p, target: f.target });
		}
	}
	return out;
}

function resolve(app: App, index: WorldIndex, sourcePath: string, link: Link): CanvasRef {
	const name = wikilinkTarget(link.value);
	if (name == null) {
		const hit = index.byId.get(link.value);
		return hit ? { kind: "file", path: hit.file.path, id: hit.id } : { kind: "text", text: `No note for ${link.value}` };
	}
	const id = buildWikilinkResolver(app, sourcePath)(name, link.target);
	if (id === AMBIGUOUS_LINK) return { kind: "text", text: `[[${name}]] names more than one note` };
	const hit = id ? index.byId.get(id) : undefined;
	return hit ? { kind: "file", path: hit.file.path, id: hit.id } : { kind: "text", text: `No note for [[${name}]]` };
}

/** Can this link value name `entry`? A cheap test before resolving, for the scan of the whole world. */
function mayName(link: Link, entry: Entry): boolean {
	const name = wikilinkTarget(link.value);
	if (name == null) return link.value === entry.id;
	const leaf = (name.split("/").pop() ?? name).replace(/\.md$/i, "").toLowerCase();
	return leaf === entry.file.basename.toLowerCase();
}

/**
 * The element in `file`, what it links to, and (with `incoming`) what links
 * to it from the world's other notes; for a Relation among them, the
 * Relation's own links. Null when the note is not an element with an id.
 */
export async function gatherRelationshipGraph(app: App, file: TFile, opts: { incoming: boolean }): Promise<RelationshipGraph | null> {
	const info = parseElementPath(file.path);
	if (!info) return null;
	const index = await indexWorld(app, info.worldName);
	const centre = index.byPath.get(file.path);
	if (!centre) return null;

	const outgoing = linksOf(centre).map((l) => ({ field: l.field, to: resolve(app, index, centre.file.path, l) }));
	const incoming: RelationshipGraph["incoming"] = [];
	if (opts.incoming) {
		for (const other of index.byPath.values()) {
			if (other === centre) continue;
			for (const l of linksOf(other)) {
				if (!mayName(l, centre)) continue;
				const ref = resolve(app, index, other.file.path, l);
				if (ref.kind === "file" && ref.path === centre.file.path) {
					incoming.push({ field: l.field, from: { kind: "file", path: other.file.path, id: other.id } });
				}
			}
		}
	}

	const through: RelationshipGraph["through"] = [];
	const onRing = new Set<string>();
	for (const ref of [...outgoing.map((l) => l.to), ...incoming.map((l) => l.from)]) {
		if (ref.kind === "file") onRing.add(ref.path);
	}
	for (const path of onRing) {
		const rel = index.byPath.get(path);
		if (!rel || rel === centre || rel.category !== "relation") continue;
		for (const l of linksOf(rel)) through.push({ relation: path, field: l.field, to: resolve(app, index, path, l) });
	}

	const name = typeof centre.fm.name === "string" && centre.fm.name.trim() ? centre.fm.name.trim() : file.basename;
	return { elementId: centre.id, elementName: name, centre: centre.file.path, outgoing, incoming, through };
}
