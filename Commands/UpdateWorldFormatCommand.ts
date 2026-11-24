import { App, Notice, TFile, TFolder } from 'obsidian';
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
	inLineEndingsOf,
	serializeFrontmatter,
	hasOwn,
	isOldSpanNote,
	repeatedHeadingMessage,
	withDependsOn,
	withoutDependsOn,
} from '../vault/element-transform';
import { editFrontmatterLines, elementNoteType, noteFence, ownFrontmatterId, parseRawFrontmatter, unclosedFenceMessage, worldElementNotes } from '../vault/element-file';
import { isElementId, isUnderElements } from '../vault/category-folder';
import { isKnownOfNote } from '../sync/known-of';
import { isStubNote } from '../sync/hidden-on-server';
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
		// The world's element notes wherever they sit in its folder, each of the
		// type its folder decides, else its `type` property (the Markdown profile).
		const elementNotes = await worldElementNotes(this.app, worldName);

		const notes: NotePlan[] = [];
		let scanned = 0;

		for (const { file } of elementNotes) {
			const content = await this.app.vault.read(file);
			const category = elementTypeOf(file.path, content);
			if (!category) {
				// An old span note is Migrate's to convert: left byte for byte, and named.
				const old = oldSpanNoteType(file.path, content);
				if (old) {
					scanned++;
					notes.push({ path: file.path, name: file.basename, category: old, movingFromFm: [], missingSections: [], missingProps: [], needsReview: true, refused: oldSpanNoteMessage(file.basename) });
				}
				continue;
			}
			const schema = getCategorySchema(category);
			if (!schema) continue;
			const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
			scanned++;
			// A known-of note leaves out what its reader does not know, and a
			// hidden element's stub holds no field of it: no scaffold is added
			// to either (the folder spec §4.4).
			if (isKnownOfNote(content) || isStubNote(content)) continue;
			// The spine list's generated section is no field.
			const { body } = ownBody(content);
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

			// A code fence typed open that swallows a `###` heading: rebuilding
			// would escape that heading into the field above and add it again
			// empty, and the next Save would clear it on onlyworlds.com.
			// Skipped and named, never rebuilt.
			// A heading that starts two sections: the rebuild would keep only the
			// last one's text. Skipped and named, never rebuilt.
			const refusal = parsed.unclosedFence
				? unclosedFenceMessage(file.basename, noteFence(content, body, category, parsed.unclosedFence), 'not updated')
				: parsed.repeated
					? repeatedHeadingMessage(file.basename, parsed.repeated, 'not updated')
					: undefined;
			if (movingFromFm.length || missingSections.length || missingProps.length) {
				notes.push({
					path: file.path,
					name: file.basename,
					category,
					movingFromFm,
					missingSections,
					missingProps,
					needsReview: legacyBodyHasFieldHeading || ambiguousHeadings.length > 0 || !!refusal,
					...(refusal ? { refused: refusal } : {}),
				});
			}
		}

		return { worldName, scanned, notes };
	}

	/** Apply the plan. Idempotent: a second run finds nothing to do. */
	private async apply(plan: WorldFormatPlan): Promise<void> {
		let changed = 0;
		let skipped = 0;
		const refusals: string[] = [];

		for (const note of plan.notes) {
			if (note.needsReview) {
				skipped++;
				if (note.refused) refusals.push(note.refused);
				continue; // never touch a note whose body is ambiguous — reported instead
			}
			const file = this.app.vault.getAbstractFileByPath(note.path);
			if (!(file instanceof TFile)) continue;

			const category = note.category;
			const schema = getCategorySchema(category);
			if (!schema) continue;

			const content = await this.app.vault.read(file);
			// Checked again from the note as it is now: a note whose id or type
			// changed while the plan was open is left, and named.
			if (elementTypeOf(file.path, content) !== category) {
				skipped++;
				refusals.push(`${file.basename} not updated: it is no longer an element note of its type (its id or type changed since the plan was made). Nothing was changed.`);
				continue;
			}
			// A known-of note leaves out what its reader does not know, and a
			// hidden element's stub holds no field of it: no scaffold is added
			// to either (the folder spec §4.4).
			if (isKnownOfNote(content) || isStubNote(content)) continue;
			// The front matter of the bytes being rewritten, not the metadata
			// cache's: this is the one read the one write is built from.
			const fmBlock = extractFrontmatterBlock(content);
			const read = fmBlock ? parseRawFrontmatter(fmBlock) : {};
			if (!read) {
				// Front matter YAML cannot read: rebuilt from nothing, it would lose every property.
				skipped++;
				refusals.push(`${file.basename} not updated: its properties are not valid YAML. Fix them, then try again.`);
				continue;
			}
			const fm: Record<string, unknown> = read;
			// The fields are rebuilt; the generated section goes back last as it
			// was, never folded into the description of a note that lacks one.
			const { body, section } = ownBody(content);
			const parsed = parseElementBody(body, category);
			if (parsed.unclosedFence) {
				// Typed open since the plan was made: skipped the same way.
				skipped++;
				refusals.push(unclosedFenceMessage(file.basename, noteFence(content, body, category, parsed.unclosedFence), 'not updated'));
				continue;
			}
			if (parsed.repeated) {
				// A heading typed twice since the plan was made: skipped the same way.
				skipped++;
				refusals.push(repeatedHeadingMessage(file.basename, parsed.repeated, 'not updated'));
				continue;
			}
			const bodyField = bodyFieldForCategory(category);

			// Update never chooses between two places a field's text could come from:
			// a text property beside a section of the same field (empty or not), or a
			// description property beside text outside every section (which is the
			// description of a note with no sections). The note is not touched, and
			// is named.
			const twice = bodyTextFields(category).filter((key) => {
				const held = fm[key];
				if (typeof held !== 'string' || !held.trim()) return false;
				return hasOwn(parsed.fields, key) || (key === bodyField && parsed.preamble.trim() !== '');
			});
			if (twice.length > 0) {
				skipped++;
				const one = twice.length === 1;
				refusals.push(`${file.basename} not updated: ${twice.join(', ')} ${one ? 'is' : 'are'} written both in the properties and in the note's body, and updating would keep only one. Keep one of them, then try again. Nothing was changed.`);
				continue;
			}
			// Text above the first section beside a section of the description is
			// the same choice inside the body: the rebuilt body keeps the section only.
			if (parsed.preamble.trim() !== '' && hasOwn(parsed.fields, bodyField)) {
				skipped++;
				refusals.push(`${file.basename} not updated: it has text above its first section and a ${fieldToHeading(bodyField)} section, and updating would keep only the section. Move the text into a section, then try again. Nothing was changed.`);
				continue;
			}

			// Values for the new body: existing sections win, then frontmatter text
			// being moved, then the legacy whole-body-is-description case. A
			// property that is empty or blank is no value, as the check above reads
			// it: taken, it would stand in for the body and the body be lost.
			const values: Record<string, unknown> = { ...parsed.fields };
			for (const key of bodyTextFields(category)) {
				const held = fm[key];
				if (values[key] === undefined && typeof held === 'string' && held.trim() !== '') values[key] = held;
			}
			if (values[bodyField] === undefined) {
				// A 3.0/3.1 note's whole body IS the description. Preserve it,
				// byte for byte as a save reads it (round C, 11).
				const legacy = [parsed.preamble, ...parsed.unknown.map((u) => u.text)]
					.filter(Boolean)
					.join('\n\n');
				if (legacy.trim()) values[bodyField] = legacy;
			}

			const customKeys = parsed.unknown
				.filter((u) => u.text.trim())
				.map((u) => `x_${u.heading.trim().toLowerCase().replace(/\s+/g, '_')}`);
			for (const u of parsed.unknown) {
				values[`x_${u.heading.trim().toLowerCase().replace(/\s+/g, '_')}`] = u.text;
			}

			// Frontmatter: add missing props, remove text fields now in the body.
			// Every other line stays as the person wrote it, a `type` that makes
			// a note outside the type folders an element among them.
			const drop: string[] = [];
			const add: Record<string, unknown> = {};
			for (const [key, def] of Object.entries(schema)) {
				if (BASE_KEYS.has(key)) continue;
				if (def.type === 'text') {
					if (hasOwn(fm, key)) drop.push(key); // its content is in the body now
					continue;
				}
				if (!hasOwn(fm, key)) {
					add[key] = def.type === 'multi_link' ? [] : def.type === 'integer' ? null : '';
				}
			}
			// A text field moves into the body only as text: a list, a map, a yes or
			// no, a number or a date the reader made would be lost on the way, so
			// the note is not touched and is named.
			const notText = drop.filter((k) => {
				const v = fm[k];
				return v !== null && v !== undefined && v !== '' && typeof v !== 'string';
			});
			if (notText.length > 0) {
				skipped++;
				const one = notText.length === 1;
				refusals.push(`${file.basename} not updated: ${notText.join(', ')} ${one ? 'holds' : 'hold'} a value that is not text, which moving ${one ? 'it' : 'them'} into the body would lose. Write ${one ? 'it' : 'them'} as text, then try again. Nothing was changed.`);
				continue;
			}
			// The person's lines are kept as written, or the note is not touched:
			// never a whole block rebuilt in another form (see editFrontmatterLines).
			const kept = editFrontmatterLines(fmBlock, drop, {}, add);
			if (kept === null) {
				skipped++;
				refusals.push(`${file.basename} not updated: its properties cannot be kept as you wrote them (an alias, an indented block or another form this command does not edit line by line). Nothing was changed.`);
				continue;
			}
			const fmText = kept || serializeFrontmatter(add);

			const newBody = buildElementBody(values, category, customKeys);
			// ★ ONE write for the whole note, front matter and body together
			// (THE WRITE RULE): never processFrontMatter on an element note.
			// The body ends as writeElement ends it, one newline after the last
			// section, or the last value's own final newline is read away
			// (round C, 11).
			const newContent = inLineEndingsOf(content, joinNote(fmText, withDependsOn(`${newBody}\n`, section)));
			if (newContent !== content) {
				this.markSelfWrite?.(file.path);
				await this.app.vault.modify(file, newContent);
			}
			changed++;
		}

		const parts = [`Updated ${changed} note${changed === 1 ? '' : 's'}`];
		if (skipped > 0) parts.push(`${skipped} skipped for review (see console)`);
		new Notice(parts.join(' · '), 10000);
		// A note skipped for its open fence is named as Save names it.
		for (const r of refusals) new Notice(r, 15000);
		if (skipped > 0) {
			console.warn(
				'[OnlyWorlds] Notes skipped — their body already contains headings that match field names, ' +
					'so migrating would move that text out of description. Review and adjust by hand:\n' +
					plan.notes.filter((n) => n.needsReview).map((n) => `  - ${n.path}`).join('\n')
			);
		}
	}
}

/**
 * The type a note is an element of (lower case), read from its own bytes, or
 * null when it is none: an element note's id is a lower-case UUID in its front
 * matter (the Markdown profile, sentence 1), so a note with no id, or another
 * plugin's or a person's own `id`, is the person's even in a type folder, and
 * is never given a scaffold. An old span note has no front matter, so it is
 * none either: Migrate converts it (oldSpanNoteType). The type is its
 * folder's, else its `type` property. Asked when the plan is made, and again
 * for each note when the confirmed run starts.
 */
function elementTypeOf(path: string, content: string): string | null {
	if (!isElementId(ownFrontmatterId(content))) return null;
	const found = elementNoteType(path, parseRawFrontmatter(content.replace(/^\s+/, '')) ?? undefined);
	return found ? normalizeCategory(found.category) : null;
}

/**
 * The type of an old span note where Migrate converts them (a type folder
 * under Elements/, the old layout and nothing else: isOldSpanNote), or null.
 * Update leaves such a note byte for byte and names it: its body is span
 * lines, not sections, and only Migrate reads them.
 */
function oldSpanNoteType(path: string, content: string): string | null {
	if (!isUnderElements(path) || !isOldSpanNote(content)) return null;
	const place = elementNoteType(path, undefined);
	return place ? normalizeCategory(place.category) : null;
}

/** What Update says of an old span note it leaves. */
export function oldSpanNoteMessage(name: string): string {
	return `${name} not updated: it is still in the plugin's old layout. Run Migrate world notes to frontmatter to convert it. Nothing was changed.`;
}

// Both delegate to splitNote/joinNote (element-transform), the single place that
// knows where frontmatter ends. They tolerate a block that does not start at
// byte 0 — see the corruption note on splitNote — and re-emit it correctly.
function extractFrontmatterBlock(content: string): string {
	const fm = splitNote(content).frontmatter;
	return fm ? `${fm}\n` : '';
}

/** The body less the spine list's generated section, and that section as it was ("" when the note has none). */
function ownBody(content: string): { body: string; section: string } {
	return withoutDependsOn(splitNote(content).body);
}
