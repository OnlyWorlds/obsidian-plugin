import { App, Notice, TFile, parseYaml } from 'obsidian';
import {
	bodyTextFields,
	fieldToHeading,
	headingToFieldKey,
	parseElementBody,
	buildElementBody,
	isExtensionKey,
	stripExtensionPrefix,
	normalizeCategory,
	getCategorySchema,
	isEmptyFieldValue,
	splitNote,
	joinNote,
	serializeFrontmatter,
} from '../vault/element-transform';

/**
 * Base identity keys are never offered for removal: name/id ARE the element,
 * and supertype/subtype/image_url are the block a reader scans first.
 */
const BASE_KEYS = new Set(['name', 'id', 'supertype', 'subtype', 'image_url']);
import { parseElementPath } from '../vault/element-file';
import { ManageFieldsModal, FieldChoice } from '../Modals/ManageFieldsModal';
import { TextPromptModal } from '../Modals/TextPromptModal';

/**
 * "Manage fields" / "Add custom field" on the active element note.
 *
 * Text fields live in the body as `## Heading` sections (v3.2), so adding or
 * removing a field is a body rewrite — frontmatter is untouched. The section
 * ORDER always follows the schema, so a note that has been added to and removed
 * from repeatedly still reads in the canonical order.
 *
 * ★ A section holding text is never removed by this command. The modal disables
 * those rows, and applySelection re-checks server-side of the UI, so a stale
 * modal cannot delete prose either.
 */
export class ManageFieldsCommand {
	constructor(private app: App, private markSelfWrite?: (path: string) => void) {}

	/** The active note, if it is an element note. Otherwise null (with a notice). */
	private activeElement(): { file: TFile; category: string } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice('No active note.');
			return null;
		}
		const info = parseElementPath(file.path);
		if (!info) {
			new Notice('This note is not an OnlyWorlds element.');
			return null;
		}
		return { file, category: normalizeCategory(info.category) };
	}

	async execute(): Promise<void> {
		const active = this.activeElement();
		if (!active) return;
		const { file, category } = active;
		const content = await this.app.vault.read(file);
		const body = stripFrontmatterBlock(content);
		const parsed = parseElementBody(body, category);

		// Schema text fields (body sections), plus custom sections already present.
		const choices: FieldChoice[] = bodyTextFields(category).map((key) => ({
			key,
			label: fieldToHeading(key),
			present: key in parsed.fields,
			hasContent: !!(parsed.fields[key] || '').trim(),
			custom: false,
			where: 'body' as const,
			group: 'Text',
		}));
		for (const u of parsed.unknown) {
			choices.push({
				key: `x_${headingToFieldKey(u.heading)}`,
				label: u.heading,
				present: true,
				hasContent: !!u.text.trim(),
				custom: true,
				where: 'body',
				group: 'Custom',
			});
		}

		// Frontmatter fields (numbers + links). Base identity keys are NOT offered:
		// name/id are the element, and supertype/subtype/image_url are the block a
		// reader scans first — a note without them is not a cleaner note.
		const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
		const schema = getCategorySchema(category);
		if (schema) {
			for (const [key, def] of Object.entries(schema)) {
				if (BASE_KEYS.has(key)) continue;
				if (def.type === 'text') continue; // body owns text
				const value = fm[key];
				choices.push({
					key,
					label: fieldToHeading(key),
					present: key in fm,
					hasContent: !isEmptyFieldValue(value),
					custom: false,
					where: 'frontmatter',
					group: def.type === 'number' ? 'Numbers' : 'Links',
				});
			}
		}

		new ManageFieldsModal(
			this.app,
			category,
			choices,
			(selected) => void this.applySelection(file, category, selected, choices),
			() => void this.addCustomField()
		).open();
	}

	/** Rewrite the body to carry exactly the selected fields, in schema order. */
	private async applySelection(
		file: TFile,
		category: string,
		selected: Set<string>,
		choices: FieldChoice[]
	): Promise<void> {
		const content = await this.app.vault.read(file);
		const fmBlock = extractFrontmatterBlock(content);
		const parsed = parseElementBody(stripFrontmatterBlock(content), category);

		// Re-check content here, not just in the UI: a field holding text is kept
		// regardless of what the modal returned (stale-modal safety).
		const keep = new Set(selected);
		for (const c of choices) if (c.hasContent) keep.add(c.key);

		const values: Record<string, unknown> = { ...parsed.fields };
		const customKeys: string[] = [];
		for (const u of parsed.unknown) {
			const key = `x_${headingToFieldKey(u.heading)}`;
			if (!keep.has(key)) continue;
			values[key] = u.text;
			customKeys.push(key);
		}
		for (const key of bodyTextFields(category)) {
			if (!keep.has(key)) delete values[key];
			else if (!(key in values)) values[key] = '';
		}

		const newBody = buildElementBody(
			values,
			category,
			customKeys,
			bodyTextFields(category).filter((k) => keep.has(k))
		);
		// (no write here — the single write below carries body AND frontmatter)

		// Frontmatter half — serialized by us, in ONE write with the body.
		//
		// ⚑ This used to call processFrontMatter, which is what corrupted notes:
		// it is async, owns the file, and could leave the block preceded by blank
		// lines (a `---` not at byte 0 stops being frontmatter, and the note then
		// renders as plain text). Two writers racing on one file also meant a
		// toggle-on could be overwritten by the other half's stale copy — which
		// is why re-ticking a field appeared to do nothing. One writer fixes both.
		const schema = getCategorySchema(category);
		const current = await this.app.vault.read(file);
		const existing = parseFrontmatterObject(current);
		const fmOut: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(existing)) {
			if (!schema || BASE_KEYS.has(key)) {
				fmOut[key] = value;
				continue;
			}
			const def = schema[key];
			if (!def || def.type === 'text') {
				fmOut[key] = value; // extension keys and anything we do not own
				continue;
			}
			// A property we own: keep it if ticked, or if it holds a real value.
			if (keep.has(key) || !isEmptyFieldValue(value)) fmOut[key] = value;
		}
		if (schema) {
			for (const [key, def] of Object.entries(schema)) {
				if (BASE_KEYS.has(key) || def.type === 'text') continue;
				if (!keep.has(key) || key in fmOut) continue;
				fmOut[key] = def.type === 'multi_link' ? [] : def.type === 'number' ? null : '';
			}
		}
		const finalContent = joinNote(serializeFrontmatter(fmOut), newBody);
		if (finalContent !== current) {
			this.markSelfWrite?.(file.path);
			await this.app.vault.modify(file, finalContent);
		}
		// ★ Last line of defence. processFrontMatter can leave the block preceded
		// by blank lines, and a note whose `---` is not at byte 0 stops being
		// frontmatter to Obsidian — it renders as plain text, and every later
		// write pushes it further down. Whatever happened above, the file leaves
		// this function normalised (2026-08-22, reproduced twice on real notes).
		await this.normalize(file);
		// No notice: applySelection runs on EVERY toggle now (live-apply), and a
		// Notice per tick would bury the screen. The note updating IS the feedback.
	}

	/**
	 * Guarantee the frontmatter block sits at byte 0. Cheap, idempotent, and
	 * safe after any write — it rewrites only when something is actually wrong.
	 */
	private async normalize(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		if (content.startsWith('---')) return; // already correct — no write
		const { frontmatter, body } = splitNote(content);
		if (!frontmatter) return; // genuinely frontmatter-less; leave it alone
		this.markSelfWrite?.(file.path);
		await this.app.vault.modify(file, joinNote(frontmatter, body));
	}

	/** Add one custom text field: `Looks` -> a `## Looks` section, stored as x_looks. */
	async addCustomField(): Promise<void> {
		const active = this.activeElement();
		if (!active) return;
		const { file, category } = active;

		new TextPromptModal(this.app, 'Custom field name', 'e.g. Looks', async (raw: string) => {
			const label = (raw || '').trim();
			if (!label) return;
			const key = headingToFieldKey(label);
			if (!key) return;
			// A custom field may not shadow a schema field — that name already has
			// a home and a type, and two sections with one heading is ambiguous.
			if (bodyTextFields(category).includes(key)) {
				new Notice(`"${label}" is already a ${category} field.`);
				return;
			}
			const content = await this.app.vault.read(file);
			const body = stripFrontmatterBlock(content);
			if (parseElementBody(body, category).unknown.some((u) => headingToFieldKey(u.heading) === key)) {
				new Notice(`"${label}" is already on this note.`);
				return;
			}
			const { frontmatter } = splitNote(content);
			const heading = fieldToHeading(key);
			// `###`, matching buildElementBody — one heading level across the note.
			const newBody = `${body.replace(/\s*$/, '')}\n\n### ${heading}\n\n`;
			this.markSelfWrite?.(file.path);
			// joinNote, never string concatenation: it puts the block at byte 0 and
			// strips leading blank lines, so this path cannot produce the note that
			// renders its own frontmatter as plain text (2026-08-22 corruption).
			await this.app.vault.modify(file, joinNote(frontmatter, newBody));
			await this.normalize(file); // same guarantee as applySelection
			new Notice(`Added custom field "${heading}" (syncs as x_${key}).`);
		}).open();
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


/** Parse the note's frontmatter block into an object (key order preserved). */
function parseFrontmatterObject(content: string): Record<string, unknown> {
	const { frontmatter } = splitNote(content);
	if (!frontmatter) return {};
	const lines = frontmatter.split(/\r?\n/);
	const inner = lines.slice(1, -1).join('\n'); // drop opening + closing ---
	try {
		const parsed = parseYaml(inner);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
