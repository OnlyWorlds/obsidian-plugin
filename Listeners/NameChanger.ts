import { App, Notice, TFile } from 'obsidian';

/**
 * NameChanger (Phase B — frontmatter).
 *
 * When a user renames an element note, keep the frontmatter `name` in sync with
 * the new filename. Only touches element notes that carry a frontmatter id, and
 * only when the current `name` still matched the OLD filename (so a deliberate,
 * different display name the user set by hand is left alone). Legacy span notes
 * are not rewritten here — they migrate via the Migrate command.
 */
export class NameChanger {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	setupNameChangeListener() {
		this.app.vault.on('rename', async (file, oldPath) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			if (!/^OnlyWorlds\/Worlds\/[^/]+\/Elements\//i.test(file.path)) return;

			const oldName = oldPath.split('/').pop()?.replace(/\.md$/, '');
			const newName = file.basename;
			if (!oldName || oldName === newName) return;

			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!fm || typeof fm.id !== 'string') return; // not a migrated element note

			// Only auto-update when the stored name tracked the old filename.
			if (typeof fm.name === 'string' && fm.name !== oldName) return;

			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				(frontmatter as Record<string, unknown>).name = newName;
			});
			new Notice('Name synchronized to: ' + newName);
		});
	}
}
