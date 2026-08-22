import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import {
	bodyTextFields,
	fieldToHeading,
	buildElementBody,
	parseElementBody,
	bodyFieldForCategory,
	getCategorySchema,
	isEmptyFieldValue,
	normalizeCategory,
	splitNote,
	joinNote,
} from '../vault/element-transform';
import { parseElementPath } from '../vault/element-file';
import { UpdateWorldFormatModal, WorldFormatPlan, NotePlan } from '../Modals/UpdateWorldFormatModal';

const BASE_KEYS = new Set(['name', 'id', 'supertype', 'subtype', 'image_url']);

/**
 * "Update World to Latest Format" — bring every note in a world up to the
 * current plugin's layout, whatever it is missing.
 *
 * Notes written by 3.0/3.1 carry only the fields that had values, with text
 * fields sitting in frontmatter and no body sections at all. This adds the
 * missing scaffold and moves text fields into `## Heading` sections.
 *
 * ★ DRY RUN FIRST, ALWAYS. This rewrites files a user has written in, so it
 * reports exactly what it would do and does nothing until they confirm.
 *
 * ⚑ The genuine hazard is not the scaffold — it is that a 3.0/3.1 body is one
 * opaque `description` blob, and a user may already have typed `## Something`
 * inside it. Once headings mean fields, that prose would relocate itself out of
 * description on the next read. So a note whose EXISTING body contains a
 * heading matching a field name is flagged in the plan and reported by name,
 * never migrated silently.
 */
export class UpdateWorldFormatCommand {
	constructor(private app: App, private markSelfWrite?: (path: string) => void) {}

	async execute(worldName: string): Promise<void> {
		const plan = await this.buildPlan(worldName);
		if (plan.notes.length === 0) {
			new Notice(`"${worldName}" is already up to date — nothing to change.`);
			return;
		}
		new UpdateWorldFormatModal(this.app, plan, () => void this.apply(plan)).open();
	}

	/** Inspect every element note and work out what it needs. Reads only. */
	async buildPlan(worldName: string): Promise<WorldFormatPlan> {
		const prefix = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements`);
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(prefix + '/'));

		const notes: NotePlan[] = [];
		let scanned = 0;

		for (const file of files) {
			const info = parseElementPath(file.path);
			if (!info) continue;
			scanned++;
			const category = normalizeCategory(info.category);
			const schema = getCategorySchema(category);
			if (!schema) continue;

			const content = await this.app.vault.read(file);
			const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
			const body = stripFrontmatterBlock(content);
			const textFields = bodyTextFields(category);

			// Text fields still living in frontmatter need to move to the body.
			const movingFromFm = textFields.filter(
				(k) => k in fm && !isEmptyFieldValue(fm[k]) && k !== bodyFieldForCategory(category)
			);

			// Which body sections already exist?
			const parsed = parseElementBody(body, category);
			const hasAnyHeading = Object.keys(parsed.fields).length > 0 || parsed.unknown.length > 0;
			const missingSections = textFields.filter((k) => !(k in parsed.fields));

			// Missing frontmatter properties (numbers + links).
			const missingProps = Object.entries(schema)
				.filter(([k, def]) => !BASE_KEYS.has(k) && def.type !== 'text' && !(k in fm))
				.map(([k]) => k);

			// ⚑ The hazard: a pre-existing body (no field headings yet) that already
			// contains a `##` matching a field name. Migrating would silently move
			// that prose out of description.
			const ambiguousHeadings = !hasAnyHeading
				? []
				: parsed.unknown
						.filter((u) => textFields.includes(u.heading.trim().toLowerCase().replace(/\s+/g, '_')))
						.map((u) => u.heading);
			const legacyBodyHasFieldHeading =
				!Object.keys(parsed.fields).length &&
				textFields.some((k) =>
					new RegExp(`^##\\s+${fieldToHeading(k)}\\s*$`, 'im').test(body)
				);

			if (movingFromFm.length || missingSections.length || missingProps.length) {
				notes.push({
					path: file.path,
					name: file.basename,
					category,
					movingFromFm,
					missingSections,
					missingProps,
					needsReview: legacyBodyHasFieldHeading || ambiguousHeadings.length > 0,
				});
			}
		}

		return { worldName, scanned, notes };
	}

	/** Apply the plan. Idempotent: a second run finds nothing to do. */
	private async apply(plan: WorldFormatPlan): Promise<void> {
		let changed = 0;
		let skipped = 0;

		for (const note of plan.notes) {
			if (note.needsReview) {
				skipped++;
				continue; // never touch a note whose body is ambiguous — reported instead
			}
			const file = this.app.vault.getAbstractFileByPath(note.path);
			if (!(file instanceof TFile)) continue;

			const category = note.category;
			const schema = getCategorySchema(category);
			if (!schema) continue;

			const content = await this.app.vault.read(file);
			const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
			const body = stripFrontmatterBlock(content);
			const parsed = parseElementBody(body, category);
			const bodyField = bodyFieldForCategory(category);

			// Values for the new body: existing sections win, then frontmatter text
			// being moved, then the legacy whole-body-is-description case.
			const values: Record<string, unknown> = { ...parsed.fields };
			for (const key of bodyTextFields(category)) {
				if (values[key] === undefined && typeof fm[key] === 'string') values[key] = fm[key];
			}
			if (values[bodyField] === undefined) {
				// A 3.0/3.1 note's whole body IS the description. Preserve it.
				const legacy = [parsed.preamble, ...parsed.unknown.map((u) => u.text)]
					.filter(Boolean)
					.join('\n\n')
					.trim();
				if (legacy) values[bodyField] = legacy;
			}

			const customKeys = parsed.unknown
				.filter((u) => u.text.trim())
				.map((u) => `x_${u.heading.trim().toLowerCase().replace(/\s+/g, '_')}`);
			for (const u of parsed.unknown) {
				values[`x_${u.heading.trim().toLowerCase().replace(/\s+/g, '_')}`] = u.text;
			}

			const fmBlock = extractFrontmatterBlock(content);
			const newBody = buildElementBody(values, category, customKeys);
			const newContent = joinNote(fmBlock, newBody);
			if (newContent !== content) {
				this.markSelfWrite?.(file.path);
				await this.app.vault.modify(file, newContent);
			}

			// Frontmatter: add missing props, remove text fields now in the body.
			this.markSelfWrite?.(file.path);
			await this.app.fileManager.processFrontMatter(file, (front) => {
				const target = front as Record<string, unknown>;
				for (const [key, def] of Object.entries(schema)) {
					if (BASE_KEYS.has(key)) continue;
					if (def.type === 'text') {
						delete target[key]; // its content is in the body now
						continue;
					}
					if (!(key in target)) {
						target[key] = def.type === 'multi_link' ? [] : def.type === 'number' ? null : '';
					}
				}
			});
			changed++;
		}

		const parts = [`Updated ${changed} note${changed === 1 ? '' : 's'}`];
		if (skipped > 0) parts.push(`${skipped} skipped for review (see console)`);
		new Notice(parts.join(' · '), 10000);
		if (skipped > 0) {
			console.warn(
				'[OnlyWorlds] Notes skipped — their body already contains headings that match field names, ' +
					'so migrating would move that text out of description. Review and adjust by hand:\n' +
					plan.notes.filter((n) => n.needsReview).map((n) => `  - ${n.path}`).join('\n')
			);
		}
	}
}

// Both delegate to splitNote/joinNote (element-transform), the single place that
// knows where frontmatter ends. They tolerate a block that does not start at
// byte 0 — see the corruption note on splitNote — and re-emit it correctly.
function extractFrontmatterBlock(content: string): string {
	const fm = splitNote(content).frontmatter;
	return fm ? `${fm}\n` : '';
}

function stripFrontmatterBlock(content: string): string {
	return splitNote(content).body;
}
