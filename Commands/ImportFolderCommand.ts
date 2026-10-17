import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { writeElement } from "../vault/element-file";
import { bodyFieldForCategory, normalizeCategory, parseRawFrontmatterScalars } from "../vault/element-transform";
import { sanitizeFileName } from "../Scripts/WorldService";
import { readWorldIdMarker, writeWorldIdMarker } from "../vault/world-id-marker";
import { readFolderSidecar, writeFolderSidecar } from "../vault/folder-sidecar";
import { renderWorldMd, worldJsonToKeep } from "../vault/world-json";
import { safeWorldFolderName } from "../vault/world-name";
import {
	parseFolderElementBody,
	owMentionsToWikilinks,
	isUuid,
	type ElementRef,
} from "../vault/folder-format";

/**
 * Import OnlyWorlds folder (S9 Phase C / Rail 2).
 *
 * Reads a conformant OnlyWorlds folder the user has placed anywhere INSIDE the
 * vault (R2 — folder picker over any folder containing a world.json), and mints
 * frontmatter element notes through Phase B's writeElement. Deterministic inverse
 * of export: same ids, same field vocabulary, ow:// -> [[wikilink]] (R3),
 * extension fields verbatim (R4 — carried by writeElement/the transform).
 *
 * Safety (R5):
 *   - NEVER overwrites an existing note silently. If an element id already exists
 *     in the target world's notes, skip + count it.
 *   - Creates a NEW world folder under OnlyWorlds/Worlds/<world name> if absent.
 *   - If a world of that name exists but with a DIFFERENT world id, ABORT with a
 *     clear message (never merge two worlds). The target world's id is recorded
 *     in a `.ow-world-id` marker note on first import so the check is stable.
 *
 * World fields (OW Infra #166 row 5, spec §4.1 no-drop): a world new to this
 * vault gets a World.md showing its description, time settings and units, and
 * the world.json itself (minus `api`) is kept in the folder sidecar so the
 * export writes every key back. An existing World.md or sidecar is never
 * overwritten.
 */
export class ImportFolderCommand {
	private app: App;
	private markSelfWrite: (path: string) => void;

	constructor(app: App, markSelfWrite: (path: string) => void = () => {}) {
		this.app = app;
		this.markSelfWrite = markSelfWrite;
	}

	async execute(): Promise<void> {
		const candidates = this.findWorldFolders();
		if (candidates.length === 0) {
			new Notice(
				"No OnlyWorlds folder found in this vault. Place a folder containing a " +
					"world.json anywhere in the vault, then run this again.",
				10000
			);
			return;
		}
		new FolderPickModal(this.app, candidates, (dir) => void this.importFolder(dir)).open();
	}

	/** Any vault folder directly containing a world.json is an import candidate. */
	private findWorldFolders(): string[] {
		const dirs = new Set<string>();
		for (const f of this.app.vault.getFiles()) {
			if (f.name.toLowerCase() === "world.json") {
				const dir = f.parent?.path ?? "";
				// Don't offer our own export root's parent by mistake — the export
				// subfolders themselves are valid, only the bare filename matters.
				dirs.add(dir);
			}
		}
		return [...dirs].sort();
	}

	private async importFolder(dir: string): Promise<void> {
		// 1. world.json — identity + name (R1a).
		const worldJsonPath = normalizePath(`${dir}/world.json`);
		const worldFile = this.app.vault.getAbstractFileByPath(worldJsonPath);
		if (!(worldFile instanceof TFile)) {
			new Notice("world.json not found in the selected folder.");
			return;
		}
		let worldMeta: Record<string, unknown>;
		try {
			worldMeta = JSON.parse(await this.app.vault.read(worldFile));
		} catch (e) {
			new Notice(`world.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		const worldId = worldMeta.id;
		const worldName = typeof worldMeta.name === "string" && worldMeta.name.trim()
			? worldMeta.name.trim()
			: null;
		if (!isUuid(worldId) || !worldName) {
			new Notice("world.json must carry a valid `id` (uuid) and `name`.", 8000);
			return;
		}

		// 2. Target world folder — create if absent; abort on id mismatch (R5).
		// The folder is one safe path segment of the name (Kael's review 3.7);
		// the world keeps its real name in World.md and on export.
		const targetWorld = safeWorldFolderName(worldName);
		const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${targetWorld}`);
		const existingId = await this.readWorldIdMarker(targetWorld);
		if (existingId && existingId !== worldId) {
			new Notice(
				`A world named "${targetWorld}" already exists with a different id. ` +
					"Import aborted — two different worlds must not be merged.",
				12000
			);
			return;
		}

		// 3. Collect element JSON files under elements/ and the legacy spatial/
		//    (spec §4: a reader SHOULD accept both; identity is the id inside).
		const elementFiles = this.app.vault
			.getFiles()
			.filter(
				(f) =>
					f.extension === "json" &&
					(f.path.startsWith(`${dir}/elements/`) || f.path.startsWith(`${dir}/spatial/`))
			);
		if (elementFiles.length === 0) {
			new Notice("The folder contains no element JSON files (elements/ or spatial/).");
			return;
		}

		// Pass 1 — parse every element, build the id -> ref index for ow:// resolution.
		const parsed: { type: string; payload: Record<string, unknown>; carried: Record<string, unknown>; rel: string; order: string[] }[] = [];
		const idIndex = new Map<string, ElementRef>();
		const failed: { path: string; reason: string }[] = [];
		// spec §4 (v0.3.8) "one id, one file": an id in both layouts is read from
		// its elements/ copy, never the newer local_updated_at; the other copy is
		// listed in the summary (Kael's review 3.5). Two copies in one layout:
		// the first by path, so every run reads the same one.
		const slotById = new Map<string, number>();
		const duplicates: { id: string; read: string; ignored: string }[] = [];
		const preferred = (a: string, b: string): boolean => {
			const ae = a.startsWith("elements/");
			const be = b.startsWith("elements/");
			return ae !== be ? ae : a < b;
		};
		for (const file of elementFiles) {
			try {
				const json = JSON.parse(await this.app.vault.read(file)) as Record<string, unknown>;
				// Fallback type from the containing bucket folder: <dir>/<bucket>/<type>/file.
				const rel = file.path.slice(dir.length + 1); // strip "<dir>/"
				const fallbackType = normalizeCategory(rel.split("/")[1] ?? "");
				const { type, payload, carried } = parseFolderElementBody(json, fallbackType);
				const id = payload.id;
				const name = payload.name;
				if (!isUuid(id) || typeof name !== "string") {
					failed.push({ path: file.path, reason: "missing valid id or name" });
					continue;
				}
				const slot = slotById.get(id);
				if (slot !== undefined) {
					const other = parsed[slot].rel;
					if (!preferred(rel, other)) {
						duplicates.push({ id, read: other, ignored: rel });
						continue;
					}
					duplicates.push({ id, read: rel, ignored: other });
					parsed[slot] = { type, payload, carried, rel, order: Object.keys(json) };
				} else {
					slotById.set(id, parsed.length);
					parsed.push({ type, payload, carried, rel, order: Object.keys(json) });
				}
				idIndex.set(id, { id, name, type });
			} catch (e) {
				failed.push({ path: file.path, reason: e instanceof Error ? e.message : String(e) });
			}
		}
		if (parsed.length === 0) {
			new Notice("Import aborted — no readable elements in the folder.");
			return;
		}

		// Existing element ids in the target world (R5 skip-existing).
		const existingIds = await this.existingElementIds(targetWorld);

		// Plan every note's name before writing any, and render link fields as
		// `[[Name]]` from that plan, as Download does (OW Infra #166 row 17). The
		// metadata cache is not consulted: it is cold for notes written moments
		// ago in this run, so links came in as raw uuids (hop 9: 43%).
		const idToName = await this.planNoteNames(targetWorld, parsed, existingIds);

		// Pass 2 — translate prose ow:// -> [[wikilink]], mint notes via writeElement.
		const result = { created: [] as string[], skipped: [] as string[], failed, duplicates };
		const notePathOwner = new Map<string, string>(); // note path -> element id, this run
		let createdMarker = existingId !== null;
		let wroteWorldFields = false;
		const carriedById = new Map<string, Record<string, unknown>>();
		const orderById = new Map<string, string[]>();
		for (const el of parsed) {
			const id = String(el.payload.id);
			if (existingIds.has(id)) {
				result.skipped.push(id);
				continue;
			}
			try {
				const payload = { ...el.payload };
				const bodyField = bodyFieldForCategory(el.type);
				if (typeof payload[bodyField] === "string") {
					payload[bodyField] = owMentionsToWikilinks(
						payload[bodyField] as string,
						(i) => idIndex.get(i) ?? null
					);
				}
				const planned = idToName.get(id);
				const file = await writeElement(this.app, targetWorld, el.type, id, payload, {
					markSelfWrite: this.markSelfWrite,
					fileName: planned ? `${planned}.md` : undefined,
					idToName: (target) => idToName.get(target) ?? null,
				});
				// "created" must only ever count notes that still exist. writeElement
				// never hands two elements one path any more, but if it ever did, the
				// element whose note was overwritten is lost — report it as failed,
				// never as created (hop 9: 35 in, 34 out, "35 created").
				const prior = notePathOwner.get(file.path);
				if (prior !== undefined && prior !== id) {
					result.created = result.created.filter((c) => c !== prior);
					result.failed.push({ path: prior, reason: `its note ${file.path} was overwritten by ${id}` });
				}
				notePathOwner.set(file.path, id);
				result.created.push(id);
				carriedById.set(id, el.carried);
				orderById.set(id, el.order);
				existingIds.add(id);
				// Stamp the world-id marker once, after the first successful write
				// (so the folder exists) — makes the id-mismatch guard stable.
				if (!createdMarker) {
					await this.writeWorldIdMarker(targetWorld, worldId);
					createdMarker = true;
				}
				if (!wroteWorldFields) {
					await this.writeWorldFields(targetWorld, worldMeta);
					wroteWorldFields = true;
				}
			} catch (e) {
				result.failed.push({ path: id, reason: e instanceof Error ? e.message : String(e) });
			}
		}

		// What each created element carried that its note has no home for (server
		// and sync fields; OW Infra #166 row 6), and its file's key order (spec
		// §5: an export writes keys as received; Kael's review), kept for the
		// folder export. Skipped elements keep whatever an earlier import recorded.
		if (carriedById.size > 0) {
			const sidecar = await readFolderSidecar(this.app, targetWorld);
			const elements = { ...(sidecar.elements ?? {}) };
			const order = { ...(sidecar.order ?? {}) };
			for (const id of result.created) {
				const carried = carriedById.get(id);
				if (carried && Object.keys(carried).length > 0) elements[id] = carried;
				else delete elements[id];
				const keys = orderById.get(id);
				if (keys) order[id] = keys;
			}
			sidecar.elements = elements;
			sidecar.order = order;
			await writeFolderSidecar(this.app, targetWorld, sidecar);
		}

		new ImportReportModal(this.app, targetWorld, result).open();
	}

	/**
	 * The id -> note name (basename) map for link rendering, built from the
	 * folder before any note is written (OW Infra #166 row 17):
	 *   - an element this import creates: the note name it will get, the way
	 *     writeElement claims it (`<name>`, or `<name> (N)` from 1 when another
	 *     note, or an earlier element of this run, holds that path, compared
	 *     case-insensitively). Each is then written at exactly that name, so
	 *     the second of two same-named elements is `Twin (1)` and links to it
	 *     read `[[Twin (1)]]`, as Download writes twins;
	 *   - an element the import skips because the vault already has it: that
	 *     note's own basename, read from disk;
	 *   - anything else (a target outside the folder): absent, so the link
	 *     stays its uuid.
	 */
	private async planNoteNames(
		world: string,
		parsed: { type: string; payload: Record<string, unknown> }[],
		existingIds: Set<string>
	): Promise<Map<string, string>> {
		const names = new Map<string, string>();
		const inFolder = new Set(parsed.map((el) => String(el.payload.id)));
		const prefix = `OnlyWorlds/Worlds/${world}/Elements/`;
		const taken = new Set<string>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(prefix)) continue;
			taken.add(f.path.toLowerCase());
			let id: string | undefined;
			try {
				id = parseRawFrontmatterScalars((await this.app.vault.read(f)).replace(/^\s+/, ""), ["id"]).id;
			} catch {
				id = undefined;
			}
			if (id && inFolder.has(id) && existingIds.has(id)) names.set(id, f.basename);
		}
		for (const el of parsed) {
			const id = String(el.payload.id);
			if (existingIds.has(id) || names.has(id)) continue;
			const cat = normalizeCategory(el.type);
			const folder = `${prefix}${cat.charAt(0).toUpperCase()}${cat.slice(1)}`;
			const raw = typeof el.payload.name === "string" && el.payload.name ? el.payload.name : "Untitled";
			const base = sanitizeFileName(raw);
			for (let n = 0; n <= 1000; n++) {
				const leaf = n === 0 ? base : `${base} (${n})`;
				const path = normalizePath(`${folder}/${leaf}.md`).toLowerCase();
				if (taken.has(path)) continue;
				taken.add(path);
				names.set(id, leaf);
				break;
			}
		}
		return names;
	}

	/**
	 * All element ids already present in the target world's notes (R5). Each
	 * note's id is read from disk when the metadata cache has none: on a
	 * re-import before Obsidian has indexed the notes, a cache-only read missed
	 * every id and wrote a second note for each (Kael's cold read, 3).
	 */
	private async existingElementIds(world: string): Promise<Set<string>> {
		const ids = new Set<string>();
		const prefix = `OnlyWorlds/Worlds/${world}/Elements/`;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(prefix)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm && typeof fm.id === "string") {
				ids.add(fm.id);
				continue;
			}
			try {
				const id = parseRawFrontmatterScalars((await this.app.vault.read(f)).replace(/^\s+/, ""), ["id"]).id;
				if (id) ids.add(id);
			} catch {
				/* unreadable note: not an id this import can see */
			}
		}
		return ids;
	}

	/**
	 * World.md and the sidecar's world block, each only when absent: a re-import
	 * into a world this vault already has never rewrites what the user holds.
	 */
	private async writeWorldFields(world: string, worldJson: Record<string, unknown>): Promise<void> {
		const mdPath = normalizePath(`OnlyWorlds/Worlds/${world}/World.md`);
		if (!this.app.vault.getAbstractFileByPath(mdPath) && !(await this.app.vault.adapter.exists(mdPath))) {
			// World.md shows the real name; the folder is its safe form.
			const realName = typeof worldJson.name === "string" && worldJson.name.trim() ? worldJson.name.trim() : world;
			await this.app.vault.create(mdPath, renderWorldMd(worldJson, realName));
		}
		const sidecar = await readFolderSidecar(this.app, world);
		if (!sidecar.world) {
			sidecar.world = worldJsonToKeep(worldJson);
			await writeFolderSidecar(this.app, world, sidecar);
		}
	}

	// Marker I/O lives in vault/world-id-marker.ts (shared with export — the
	// stable-identity ruling). Adapter-only for the dotfile reasons documented there.
	private readWorldIdMarker(world: string): Promise<string | null> {
		return readWorldIdMarker(this.app, world);
	}

	private writeWorldIdMarker(world: string, worldId: string): Promise<void> {
		return writeWorldIdMarker(this.app, world, worldId);
	}
}

/** Folder picker over world.json-bearing candidates. */
class FolderPickModal extends Modal {
	constructor(app: App, private candidates: string[], private onPick: (dir: string) => void) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Import OnlyWorlds folder" });
		const p = contentEl.createEl("p", {
			text:
				"Pick a folder (one containing a world.json) to import as frontmatter notes. " +
				"Existing notes are never overwritten — matching ids are skipped.",
		});
		p.style.fontSize = "0.9em";
		for (const dir of this.candidates) {
			new Setting(contentEl).setName(dir || "(vault root)").addButton((b) =>
				b
					.setButtonText("Import")
					.setCta()
					.onClick(() => {
						this.close();
						this.onPick(dir);
					})
			);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** End-of-run report (R5 shape: N created / N skipped-existing / N failed). */
class ImportReportModal extends Modal {
	constructor(
		app: App,
		private world: string,
		private result: {
			created: string[];
			skipped: string[];
			failed: { path: string; reason: string }[];
			duplicates: { id: string; read: string; ignored: string }[];
		}
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Imported — ${this.world}` });

		const summary = contentEl.createEl("ul");
		summary.createEl("li", { text: `${this.result.created.length} created` });
		summary.createEl("li", { text: `${this.result.skipped.length} skipped (id already present)` });
		summary.createEl("li", { text: `${this.result.failed.length} failed` });
		if (this.result.duplicates.length > 0) {
			summary.createEl("li", { text: `${this.result.duplicates.length} element(s) found twice: one copy read, the other ignored` });
		}

		if (this.result.duplicates.length > 0) {
			contentEl.createEl("h3", { text: "Found twice" });
			const list = contentEl.createEl("ul");
			for (const d of this.result.duplicates) list.createEl("li", { text: `${d.id}: read ${d.read}, ignored ${d.ignored}` });
		}

		if (this.result.failed.length > 0) {
			contentEl.createEl("h3", { text: "Failed elements" });
			const list = contentEl.createEl("ul");
			for (const f of this.result.failed) list.createEl("li", { text: `${f.path} — ${f.reason}` });
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("Close").setCta().onClick(() => this.close())
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
