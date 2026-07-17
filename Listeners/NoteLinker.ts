import { App, Editor, MarkdownView, Notice, PluginManifest, TFile, WorkspaceLeaf } from 'obsidian';
import { FIELD_SCHEMA } from '@onlyworlds/sdk';
import { WorldService } from 'Scripts/WorldService';
import { ElementSelectionModal } from '../Modals/ElementSelectionModal';
import { FieldSelectionModal, LinkFieldChoice } from '../Modals/FieldSelectionModal';
import { normalizeCategory, toWikilink, wikilinkTarget } from '../vault/element-transform';
import { sanitizeFileName } from 'Scripts/WorldService';

/**
 * NoteLinker (Phase B — frontmatter).
 *
 * The link system now reads structured frontmatter via metadataCache and the
 * SDK FIELD_SCHEMA, not rendered-HTML span markup (which killed the four
 * archaeology brittleness classes at the root: HTML-regex detection, span id
 * scraping, filename-collision link resolution, comma-joined multi values).
 *
 * "Link Elements" on an element note:
 *   1. resolves the element's category from its path,
 *   2. offers its single_link / multi_link fields (from FIELD_SCHEMA),
 *   3. shows a picker of target-type elements (by name, storing id),
 *   4. writes ids into frontmatter — single_link as a string, multi_link as a
 *      YAML list (unioned with existing), never a comma-joined string (R4).
 *
 * Body [[wikilinks]] are left untouched — they remain prose cross-references.
 */
export class NoteLinker {
	public currentEditor: Editor | null = null;
	private app: App;
	private worldService: WorldService;
	private manifest: PluginManifest;

	constructor(app: App, worldService: WorldService, manifest: PluginManifest) {
		this.app = app;
		this.worldService = worldService;
		this.manifest = manifest;
	}

	handleLeafChange(leaf: WorkspaceLeaf | null) {
		if (leaf && leaf.view instanceof MarkdownView) {
			this.currentEditor = leaf.view.editor;
		} else {
			this.currentEditor = null;
		}
	}

	/** Category (lowercase singular) for a path, or null if not an element note. */
	private categoryForPath(path: string): string | null {
		const m = /^OnlyWorlds\/Worlds\/([^/]+)\/Elements\/([^/]+)\/.+\.md$/i.exec(path);
		if (!m) return null;
		return normalizeCategory(m[2].replace(/\s*\(\d+\)$/, ''));
	}

	/** The link fields (single/multi) for a category, derived from FIELD_SCHEMA. */
	private linkFieldsFor(category: string, file: TFile): LinkFieldChoice[] {
		const schema = (FIELD_SCHEMA as Record<string, Record<string, { type: string; target?: string }>>)[category];
		if (!schema) return [];
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const out: LinkFieldChoice[] = [];
		for (const [key, def] of Object.entries(schema)) {
			if (def.type === 'single_link' || def.type === 'multi_link') {
				// Count current links so the modal can show empty vs filled.
				const v = (fm as Record<string, unknown>)[key];
				const count = Array.isArray(v)
					? v.filter((x) => x != null && x !== '').length
					: (v != null && v !== '' ? 1 : 0);
				out.push({
					key,
					label: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
					multi: def.type === 'multi_link',
					target: def.target ?? key,
					count,
				});
			}
		}
		return out;
	}

	/**
	 * Entry point for the "Link Elements" command. Opens the field picker, then
	 * the element picker, then writes ids into frontmatter.
	 */
	public async linkActiveNote(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile)) {
			new Notice('Open an element note first.');
			return;
		}
		const category = this.categoryForPath(file.path);
		if (!category) {
			new Notice('This note is not an OnlyWorlds element.');
			return;
		}
		const fields = this.linkFieldsFor(category, file);
		if (fields.length === 0) {
			new Notice(`No link fields for ${category}.`);
			return;
		}

		new FieldSelectionModal(this.app, category, fields, (choice) => {
			void this.pickAndLink(file, choice);
		}).open();
	}

	private async pickAndLink(file: TFile, choice: LinkFieldChoice): Promise<void> {
		const worldName = this.extractWorldName(file.path);
		const selfId = this.app.metadataCache.getFileCache(file)?.frontmatter?.id as string | undefined;

		const fetchElements = () => this.fetchElementsOfType(worldName, choice.target, selfId);
		const elements = await fetchElements();

		// The field's CURRENT links, resolved to ids, so the picker can pre-check
		// them and offer removal. Values are [[Name]] wikilinks or raw ids.
		const preselectedIds = this.currentLinkedIds(file, choice.key);

		const modal = new ElementSelectionModal(
			this.app,
			elements,
			choice.target,
			choice.label,
			choice.multi,
			preselectedIds,
			// The picker returns the FULL desired set; writeLink replaces the field.
			(selected) => void this.writeLink(file, choice, selected),
			this.worldService,
			this.manifest,
			fetchElements
		);
		modal.open();
	}

	/** The ids currently linked in `key` on `file`. Resolves [[Name]] wikilinks
	 *  via Obsidian's path-aware resolver; keeps bare ids as-is. */
	private currentLinkedIds(file: TFile, key: string): Set<string> {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const raw = (fm as Record<string, unknown>)[key];
		const values = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
		const ids = new Set<string>();
		for (const v of values) {
			const s = String(v);
			const name = wikilinkTarget(s);
			if (name != null) {
				const dest = this.app.metadataCache.getFirstLinkpathDest(name, file.path);
				const id = dest ? this.app.metadataCache.getFileCache(dest)?.frontmatter?.id : undefined;
				if (typeof id === 'string') ids.add(id);
			} else if (s) {
				ids.add(s); // bare id
			}
		}
		return ids;
	}

	/** Set the field to EXACTLY the selected links, as clickable `[[Name]]`
	 *  wikilinks (single string / multi list). The picker returns the full
	 *  desired set (add + remove), so this replaces rather than merges. Wikilink
	 *  target = sanitized name (matches the element note's on-disk basename so it
	 *  resolves). 3.0.0: link fields render as names, not raw ids. */
	private async writeLink(
		file: TFile,
		choice: LinkFieldChoice,
		selected: { name: string; id: string }[]
	): Promise<void> {
		const links = selected.map((e) => toWikilink(sanitizeFileName(e.name)));
		await this.app.fileManager.processFrontMatter(file, (fm) => {
			const target = fm as Record<string, unknown>;
			if (choice.multi) {
				target[choice.key] = links; // exactly the chosen set (may be empty)
			} else {
				target[choice.key] = links.length ? links[0] : null;
			}
		});
		const label = selected.length ? selected.map((e) => e.name).join(', ') : '(none)';
		new Notice(`${choice.label}: ${label}`);
	}

	/** id+name of every element of `target` type in the world (excludes self). */
	private async fetchElementsOfType(
		worldName: string,
		target: string,
		selfId?: string
	): Promise<{ name: string; id: string }[]> {
		const folder = capitalize(target);
		const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/${folder}`;
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix + '/') || f.path.startsWith(prefix + ' ('));
		const out: { name: string; id: string }[] = [];
		for (const f of files) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			const id = fm?.id;
			if (typeof id !== 'string' || id === selfId) continue;
			const name = typeof fm?.name === 'string' ? fm.name : f.basename;
			out.push({ name, id });
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	private extractWorldName(filePath: string): string {
		const parts = filePath.split('/');
		const i = parts.indexOf('Worlds');
		return i !== -1 && parts.length > i + 1 ? parts[i + 1] : 'Unknown World';
	}
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
