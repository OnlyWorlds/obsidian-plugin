import { App, Modal, Notice, Setting, TFile, TFolder, normalizePath } from 'obsidian';
import {
	isSpanFormat,
	parseSpanNote,
	spanFieldsToFrontmatter,
	normalizeCategory,
	apiDataToFrontmatter,
} from '../vault/element-transform';

interface MigrationResult {
	converted: string[];
	skipped: string[]; // already frontmatter
	failed: { path: string; reason: string }[];
	/** Links whose [[name]] resolved to no element — dropped from the migrated
	 * id lists but preserved in the backup. Surfaced so the loss is never silent. */
	unresolvedLinks: { path: string; names: string[] }[];
	backupFolder: string;
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

	private elementFilesFor(world: string): TFile[] {
		const prefix = `OnlyWorlds/Worlds/${world}/Elements/`;
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
	}

	private categoryForPath(path: string): string | null {
		const m = /^OnlyWorlds\/Worlds\/[^/]+\/Elements\/([^/]+)\/.+\.md$/i.exec(path);
		if (!m) return null;
		return normalizeCategory(m[1].replace(/\s*\(\d+\)$/, ''));
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

	private async migrateWorld(world: string): Promise<void> {
		const files = this.elementFilesFor(world);
		if (files.length === 0) {
			new Notice(`No element notes found in ${world}.`);
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

		// Build the link resolver from the span notes (pre-migration).
		const spanIndex = await this.scrapeSpanIndex(files);
		const resolve = (name: string) => spanIndex.get(name) ?? null;

		const result: MigrationResult = {
			converted: [], skipped: [], failed: [], unresolvedLinks: [], backupFolder,
		};

		for (const file of files) {
			try {
				const content = await this.app.vault.read(file);
				if (!isSpanFormat(content)) {
					result.skipped.push(file.path); // already frontmatter — idempotent
					continue;
				}
				const category = this.categoryForPath(file.path);
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
				await this.writeFrontmatterNote(file, category, parsed.id, frontmatter, bodyValue);
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
	 */
	private async writeFrontmatterNote(
		file: TFile,
		category: string,
		id: string,
		frontmatter: Record<string, unknown>,
		bodyValue: string
	): Promise<void> {
		// Seed the frontmatter block + body, then let processFrontMatter type the
		// values. `frontmatter` already excludes the body field (span parse split
		// it into bodyValue), and apiDataToFrontmatter normalizes link ids and
		// preserves extension keys.
		// The guard is one-shot per path and BOTH calls below fire a 'modify'
		// event — mark before each so auto-sync never sees migration writes.
		this.markSelfWrite(file.path);
		await this.app.vault.modify(file, `---\nid: ${id}\n---\n\n${bodyValue}\n`);
		const fm = apiDataToFrontmatter(frontmatter, category, id);
		this.markSelfWrite(file.path);
		await this.app.fileManager.processFrontMatter(file, (target) => {
			const t = target as Record<string, unknown>;
			for (const [k, v] of Object.entries(fm)) t[k] = v;
		});
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
