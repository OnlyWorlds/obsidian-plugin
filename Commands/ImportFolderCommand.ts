import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from "obsidian";
import { writeElement } from "../vault/element-file";
import { bodyFieldForCategory, normalizeCategory } from "../vault/element-transform";
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
		const targetWorld = worldName;
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

		// 3. Collect element JSON files under elements/ and spatial/.
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
		const parsed: { type: string; payload: Record<string, unknown> }[] = [];
		const idIndex = new Map<string, ElementRef>();
		const failed: { path: string; reason: string }[] = [];
		for (const file of elementFiles) {
			try {
				const json = JSON.parse(await this.app.vault.read(file)) as Record<string, unknown>;
				// Fallback type from the containing bucket folder: <dir>/<bucket>/<type>/file.
				const rel = file.path.slice(dir.length + 1); // strip "<dir>/"
				const fallbackType = normalizeCategory(rel.split("/")[1] ?? "");
				const { type, payload } = parseFolderElementBody(json, fallbackType);
				const id = payload.id;
				const name = payload.name;
				if (!isUuid(id) || typeof name !== "string") {
					failed.push({ path: file.path, reason: "missing valid id or name" });
					continue;
				}
				parsed.push({ type, payload });
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

		// Pass 2 — translate prose ow:// -> [[wikilink]], mint notes via writeElement.
		const result = { created: [] as string[], skipped: [] as string[], failed };
		let createdMarker = existingId !== null;
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
				await writeElement(this.app, targetWorld, el.type, id, payload, {
					markSelfWrite: this.markSelfWrite,
				});
				result.created.push(id);
				existingIds.add(id);
				// Stamp the world-id marker once, after the first successful write
				// (so the folder exists) — makes the id-mismatch guard stable.
				if (!createdMarker) {
					await this.writeWorldIdMarker(targetWorld, worldId);
					createdMarker = true;
				}
			} catch (e) {
				result.failed.push({ path: id, reason: e instanceof Error ? e.message : String(e) });
			}
		}

		new ImportReportModal(this.app, targetWorld, result).open();
	}

	/** All element ids already present in the target world's notes (R5). */
	private async existingElementIds(world: string): Promise<Set<string>> {
		const ids = new Set<string>();
		const prefix = `OnlyWorlds/Worlds/${world}/Elements/`;
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (!f.path.startsWith(prefix)) continue;
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm && typeof fm.id === "string") ids.add(fm.id);
		}
		return ids;
	}

	/** Read the persisted world-id marker (null if the world is new). */
	private async readWorldIdMarker(world: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(
			normalizePath(`OnlyWorlds/Worlds/${world}/.ow-world-id.md`)
		);
		if (!(file instanceof TFile)) return null;
		try {
			const m = /world_id:\s*([0-9a-fA-F-]{36})/.exec(await this.app.vault.read(file));
			return m ? m[1] : null;
		} catch {
			return null;
		}
	}

	private async writeWorldIdMarker(world: string, worldId: string): Promise<void> {
		const folder = normalizePath(`OnlyWorlds/Worlds/${world}`);
		if (!this.app.vault.getAbstractFileByPath(folder)) return; // writeElement makes it
		const path = normalizePath(`${folder}/.ow-world-id.md`);
		if (this.app.vault.getAbstractFileByPath(path)) return;
		this.markSelfWrite(path);
		await this.app.vault.create(
			path,
			`---\nworld_id: ${worldId}\n---\n\nOnlyWorlds folder identity marker (do not edit).\n`
		);
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
		private result: { created: string[]; skipped: string[]; failed: { path: string; reason: string }[] }
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
