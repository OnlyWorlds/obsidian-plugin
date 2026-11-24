import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from 'obsidian';
import {
	hasOldSpanIdLine,
	isOldSpanNote,
	oldSpanNoteId,
	parseSpanNote,
	serializeFrontmatter,
	spanFieldsToFrontmatter,
	normalizeCategory,
	apiDataToFrontmatter,
	bodyFieldForCategory,
	buildElementBody,
	getCategorySchema,
	hasOwn,
	isExtensionKey,
	inLineEndingsOf,
	joinNote,
	splitNote,
} from '../vault/element-transform';
import { sanitizeFileName } from '../Scripts/WorldService';
import { isUnderElements, mayBeElementNote } from '../vault/category-folder';
import { elementNoteType, ownFrontmatterId, parseRawFrontmatter } from '../vault/element-file';

interface MigrationResult {
	converted: string[];
	skipped: string[]; // already frontmatter
	failed: { path: string; reason: string }[];
	/** Links whose [[name]] resolved to no element — dropped from the migrated
	 * id lists but preserved in the backup. Surfaced so the loss is never silent. */
	unresolvedLinks: { path: string; names: string[] }[];
	backupFolder: string;
	/** Old span notes outside the type folders under Elements/: not converted, named so none is left without a word. */
	left: { path: string; reason: string }[];
}

/**
 * Migrate a world's element notes from the legacy <span> body format to YAML
 * frontmatter (S9 Phase B / R2).
 *
 * Sequence:
 *   1. Full backup of the world's element notes into
 *      OW-backup-<world>-<timestamp>/ inside the vault. Abort entirely if the
 *      backup fails — nothing is touched.
 *   2. Convert each span note to frontmatter (idempotent: notes already in
 *      frontmatter are skipped).
 *   3. Report modal: N converted / N skipped / N failed (with filenames).
 *
 * Reversibility is the backup folder (stated in the report).
 */
export class MigrateWorldCommand {
	private app: App;
	private markSelfWrite: (path: string) => void;

	/**
	 * markSelfWrite: auto-sync's self-write guard. Migration MUST be local-only —
	 * without this, a user with auto-sync enabled would mass-PATCH every migrated
	 * note to the server, and a mis-migrated note would ship upstream where the
	 * backup folder can't undo it (the server write breaks reversibility).
	 */
	constructor(app: App, markSelfWrite: (path: string) => void = () => {}) {
		this.app = app;
		this.markSelfWrite = markSelfWrite;
	}

	async execute(): Promise<void> {
		const worlds = this.getWorldFolders();
		if (worlds.length === 0) {
			new Notice('No OnlyWorlds worlds found in this vault.');
			return;
		}
		new WorldPickModal(this.app, worlds, (world) => void this.migrateWorld(world)).open();
	}

	private getWorldFolders(): string[] {
		const worldsPath = normalizePath('OnlyWorlds/Worlds');
		const root = this.app.vault.getAbstractFileByPath(worldsPath);
		if (!(root instanceof TFolder)) return [];
		return root.children.filter((c): c is TFolder => c instanceof TFolder).map((f) => f.name);
	}

	/**
	 * What Migrate does with each note of the world's folder, read once.
	 *
	 * An old span note is a note in the plugin's old layout and nothing else
	 * (isOldSpanNote: no front matter, every line a span field or group line).
	 * It is converted only where the plugin wrote such notes, in a type folder
	 * under `Elements/`; one anywhere else in the world's folder is left as it
	 * is and reported, so the person can move it into its type's folder. A note
	 * with no front matter that has an old `Id` line among other lines is the
	 * person's own and is reported too, so no old-looking note is left without
	 * a word. An element note in front matter is counted as skipped. A note
	 * that cannot be read stops the run before anything is backed up or changed.
	 */
	private async survey(world: string): Promise<{
		convert: Array<{ file: TFile; category: string }>;
		skipped: string[];
		left: { path: string; reason: string }[];
		unreadable: string[];
		/** Every readable old span note, converted or left: the link targets, as before the survey narrowed what is converted. */
		linkSources: TFile[];
	}> {
		const out = { convert: [] as Array<{ file: TFile; category: string }>, skipped: [] as string[], left: [] as { path: string; reason: string }[], unreadable: [] as string[], linkSources: [] as TFile[] };
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!mayBeElementNote(file.path, world)) continue;
			let content: string;
			try {
				content = await this.app.vault.read(file);
			} catch {
				out.unreadable.push(file.path);
				continue;
			}
			const block = splitNote(content).frontmatter;
			if (block) {
				const fmId = ownFrontmatterId(content);
				if (fmId && elementNoteType(file.path, parseRawFrontmatter(block) ?? { id: fmId })) out.skipped.push(file.path); // already frontmatter: idempotent
				continue;
			}
			if (!oldSpanNoteId(content)) {
				if (hasOldSpanIdLine(content)) out.left.push({ path: file.path, reason: 'old span lines among other lines: read as your own, not converted' });
				continue; // the person's own note
			}
			out.linkSources.push(file);
			const place = isUnderElements(file.path) ? elementNoteType(file.path, {}) : null;
			if (place) out.convert.push({ file, category: normalizeCategory(place.category) });
			else out.left.push({ path: file.path, reason: 'an old note outside the type folders under Elements/: move it into its type\'s folder there, then run Migrate again' });
		}
		return out;
	}

	// A cache-independent span id/name scrape for building the resolver, since a
	// pre-migration note has no frontmatter in metadataCache.
	private async scrapeSpanIndex(files: TFile[]): Promise<Map<string, string>> {
		const index = new Map<string, string>();
		for (const f of files) {
			try {
				const content = await this.app.vault.read(f);
				const parsed = parseSpanNote(content);
				if (parsed.id) {
					index.set(parsed.name ?? f.basename, parsed.id);
					index.set(f.basename, parsed.id);
				}
			} catch {
				/* skip unreadable */
			}
		}
		return index;
	}

	/** id -> sanitized display name, so migrated link fields render as clickable
	 *  `[[Name]]` wikilinks. Sanitized to match the note's on-disk basename. */
	private async scrapeIdToName(files: TFile[]): Promise<(id: string) => string | null> {
		const map = new Map<string, string>();
		for (const f of files) {
			try {
				const parsed = parseSpanNote(await this.app.vault.read(f));
				const name = parsed.name ?? f.basename;
				if (parsed.id && name) map.set(parsed.id, sanitizeFileName(name));
			} catch {
				/* skip unreadable */
			}
		}
		return (id: string) => map.get(id) ?? null;
	}

	private async migrateWorld(world: string): Promise<void> {
		const found = await this.survey(world);
		if (found.unreadable.length > 0) {
			new Notice(`Migration aborted: ${found.unreadable.join(', ')} could not be read. Nothing was backed up or changed.`, 15000);
			return;
		}
		const files = found.convert.map((n) => n.file);
		const categoryOf = new Map(found.convert.map((n) => [n.file.path, n.category]));
		if (files.length === 0) {
			const left = found.left.length
				? ` ${found.left.length} old note${found.left.length === 1 ? ' is' : 's are'} outside the type folders under Elements/ and ${found.left.length === 1 ? 'was' : 'were'} left as ${found.left.length === 1 ? 'it is' : 'they are'}: ${found.left.map((l) => l.path).join(', ')}.`
				: '';
			new Notice(`No old notes to migrate in ${world}.${left}`, left ? 15000 : 5000);
			return;
		}

		// 1. BACKUP FIRST — abort entirely on any failure.
		const ts = new Date().toISOString().replace(/[:.]/g, '-');
		const backupFolder = `OW-backup-${world}-${ts}`;
		try {
			await this.backupNotes(files, world, backupFolder);
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			new Notice(`Migration aborted — backup failed: ${reason}`, 10000);
			return;
		}

		// Build the link resolvers from the span notes (pre-migration): name->id
		// for resolving span [[names]], and id->name so migrated link fields
		// render as readable [[Name]] wikilinks instead of raw ids (audit polish
		// 2026-07-17 — migration is the one write path that skipped this).
		const spanIndex = await this.scrapeSpanIndex(found.linkSources);
		const resolve = (name: string) => spanIndex.get(name) ?? null;
		const idToName = await this.scrapeIdToName(found.linkSources);

		const result: MigrationResult = {
			converted: [], skipped: found.skipped, failed: [], unresolvedLinks: [], backupFolder, left: found.left,
		};

		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				if (!isOldSpanNote(content)) {
					result.skipped.push(file.path); // changed since the survey: no longer an old note
					continue;
				}
				const category = categoryOf.get(file.path);
				if (!category) {
					result.failed.push({ path: file.path, reason: 'not an element path' });
					continue;
				}
				const parsed = parseSpanNote(content);
				if (!parsed.id) {
					result.failed.push({ path: file.path, reason: 'no id found in span note' });
					continue;
				}
				const { frontmatter, bodyValue, unresolved } = spanFieldsToFrontmatter(parsed, category, resolve);
				await this.writeFrontmatterNote(file, content, category, parsed.id, frontmatter, bodyValue, idToName);
				result.converted.push(file.path);
				if (unresolved.length > 0) {
					result.unresolvedLinks.push({ path: file.path, names: unresolved });
				}
			} catch (e) {
				result.failed.push({ path: file.path, reason: e instanceof Error ? e.message : String(e) });
			}
		}

		new MigrationReportModal(this.app, world, result).open();
	}

	/** Copy each element note into OW-backup-<world>-<ts>/ preserving structure. */
	private async backupNotes(files: TFile[], world: string, backupFolder: string): Promise<void> {
		await this.ensureFolder(backupFolder);
		for (const f of files) {
			const content = await this.app.vault.read(f);
			// Mirror the path under Elements/ into the backup folder.
			const rel = f.path.replace(`OnlyWorlds/Worlds/${world}/`, '');
			const dest = normalizePath(`${backupFolder}/${rel}`);
			await this.ensureFolder(dest.substring(0, dest.lastIndexOf('/')));
			await this.app.vault.create(dest, content);
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const norm = normalizePath(path);
		if (!norm || this.app.vault.getAbstractFileByPath(norm)) return;
		// Create parent chain segment by segment.
		const parts = norm.split('/');
		let cur = '';
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.app.vault.getAbstractFileByPath(cur)) {
				await this.app.vault.createFolder(cur);
			}
		}
	}

	/**
	 * Overwrite `file` in place with frontmatter + body. In-place (not via
	 * writeElement) so the filename/location is preserved exactly and the
	 * backup remains the sole source of the old bytes.
	 *
	 * ONE write (THE WRITE RULE): the block is built here and joined to the
	 * body, never processFrontMatter. `frontmatter` already excludes the body
	 * field (span parse split it into bodyValue), and apiDataToFrontmatter
	 * normalizes link ids and preserves extension keys. An old note has no
	 * front matter (isOldSpanNote), so the block is the migrated keys alone.
	 */
	private async writeFrontmatterNote(
		file: TFile,
		content: string,
		category: string,
		id: string,
		frontmatter: Record<string, unknown>,
		bodyValue: string,
		idToName: (id: string) => string | null
	): Promise<void> {
		const fm = apiDataToFrontmatter(frontmatter, category, id, { resolveIdToName: idToName });
		const fmText = serializeFrontmatter(fm);
		// Every text field goes into the body as its section, as writeElement writes
		// a note (apiDataToFrontmatter leaves text fields out of the front matter);
		// a span field the type no longer has keeps its value as a section of its own.
		const schema = getCategorySchema(category) ?? {};
		const values: Record<string, unknown> = { ...frontmatter, [bodyFieldForCategory(category)]: bodyValue };
		const extra: string[] = [];
		for (const [k, v] of Object.entries(frontmatter)) {
			if (k === 'id' || k === 'name' || hasOwn(schema, k) || isExtensionKey(k) || v == null || v === '') continue;
			values[`x_${k}`] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
			extra.push(`x_${k}`);
		}
		const body = buildElementBody(values, category, extra);
		// The guard is one-shot per path: marked before the one 'modify' so
		// auto-sync never sees a migration write.
		this.markSelfWrite(file.path);
		await this.app.vault.modify(file, inLineEndingsOf(content, joinNote(fmText, `${body}\n`)));
	}
}

/** Minimal world picker for the migration flow (clear, migration-specific copy). */
class WorldPickModal extends Modal {
	private worlds: string[];
	private onPick: (world: string) => void;

	constructor(app: App, worlds: string[], onPick: (world: string) => void) {
		super(app);
		this.worlds = worlds;
		this.onPick = onPick;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: 'Migrate world notes to frontmatter' });
		const p = contentEl.createEl('p', {
			text:
				'Converts this world\'s element notes from the old span format to YAML frontmatter. ' +
				'A full backup is made first (OW-backup-<world>-<timestamp>/). Running again is safe — ' +
				'already-migrated notes are skipped.',
		});
		p.style.fontSize = '0.9em';
		for (const world of this.worlds) {
			new Setting(contentEl).setName(world).addButton((b) =>
				b
					.setButtonText('Migrate')
					.setCta()
					.onClick(() => {
						this.close();
						this.onPick(world);
					})
			);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** End-of-run report (R2 step 3). */
class MigrationReportModal extends Modal {
	private world: string;
	private result: MigrationResult;

	constructor(app: App, world: string, result: MigrationResult) {
		super(app);
		this.world = world;
		this.result = result;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h2', { text: `Migration complete — ${this.world}` });

		const summary = contentEl.createEl('ul');
		summary.createEl('li', { text: `${this.result.converted.length} converted` });
		summary.createEl('li', { text: `${this.result.skipped.length} skipped (already frontmatter)` });
		summary.createEl('li', { text: `${this.result.failed.length} failed` });

		const backup = contentEl.createEl('p');
		backup.createEl('strong', { text: 'Backup (undo): ' });
		backup.appendText(`${this.result.backupFolder}/ — restore these files to revert.`);

		if (this.result.failed.length > 0) {
			contentEl.createEl('h3', { text: 'Failed notes' });
			const list = contentEl.createEl('ul');
			for (const f of this.result.failed) {
				list.createEl('li', { text: `${f.path} — ${f.reason}` });
			}
		}

		if (this.result.left.length > 0) {
			contentEl.createEl('h3', { text: 'Old notes left as they are' });
			const list = contentEl.createEl('ul');
			for (const l of this.result.left) {
				list.createEl('li', { text: `${l.path} — ${l.reason}` });
			}
		}

		if (this.result.unresolvedLinks.length > 0) {
			contentEl.createEl('h3', { text: 'Unresolved links (dropped — originals in backup)' });
			const list = contentEl.createEl('ul');
			for (const u of this.result.unresolvedLinks) {
				list.createEl('li', { text: `${u.path} — ${u.names.join(', ')}` });
			}
		}

		new Setting(contentEl).addButton((b) =>
			b.setButtonText('Close').setCta().onClick(() => this.close())
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
