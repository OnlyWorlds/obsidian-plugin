import { App, TFile, TFolder, normalizePath, parseYaml } from "obsidian";
import { sanitizeFileName } from "../Scripts/WorldService";
import { categoryFolderType, isElementId, isInCategoryFolder, isUnderElements, typeOfPlace, typeOfProperty, worldNotePath, inUnreadFolder, mayBeElementNote } from "./category-folder";
import {
	frontmatterToPayloadFields,
	apiDataToFrontmatter,
	buildElementBody,
	bodyToFieldValues,
	parseElementBody,
	headingToFieldKey,
	readsAsCustomField,
	isExtensionKey,
	isUserCustomKey,
	toolShadowHeadings,
	splitNote,
	frontmatterClose,
	joinNote,
	serializeFrontmatter,
	bodyFieldForCategory,
	normalizeCategory,
	getCategorySchema,
	isOldSpanNote,
	oldSpanNoteId,
	parseSpanNote,
	spanFieldsToFrontmatter,
	parseRawFrontmatterScalars,
	AMBIGUOUS_LINK,
	likelyLinkField,
	bodyTextFields,
	SERVER_FIELDS,
	OWN_PROPERTIES_KEY,
	hasOwn,
	serverFieldsOf,
	DEPENDS_ON_KEY,
	DEPENDS_ON_CUSTOM_KEY,
	dependsOnSection,
	dependsOnOwnText,
	withDependsOn,
	withoutDependsOn,
	repeatedHeadingMessage,
	writesAsSection,
	heldHeadingsOf,
} from "./element-transform";
import {
	KNOWN_OF_KEY,
	KNOWN_OF_LINE,
	KNOWN_OF_WRITTEN_KEY,
	isKnownOfNote,
	knownOfKept,
	knownOfOwnSections,
	knownOfRecord,
	knownOfWritten,
	noteStateOf,
	withoutKnownOfLine,
} from "../sync/known-of";

/**
 * Element file format (v2 / frontmatter).
 *
 * Each element note has:
 *   - YAML frontmatter holding structured fields (id, name, plus element-type
 *     fields per FIELD_SCHEMA) AND any extension-namespaced keys
 *     (atlas_, shadow_, x_ prefixes) preserved verbatim.
 *   - Body containing the long-form text: `description` for all types EXCEPT
 *     Narrative, where the body is `story` (R5).
 *
 * This module is the Obsidian-facing wiring; the pure serialization logic lives
 * in element-transform.ts (unit-tested under `npm test`).
 *
 * READ tolerance: a note not yet migrated (still in the legacy <span> body
 * format) is parsed by the span reader so it is never data loss (R1). New
 * writes are always frontmatter.
 */

export interface ParsedElement {
	id: string;
	name: string;
	category: string; // lowercase singular, e.g. "character"
	worldName: string;
	fields: Record<string, unknown>; // snake_case, ready for the v2 payload builder
	/**
	 * `[[Name]]` link targets that resolved to no local note, so their whole
	 * field was omitted to protect the server's copy. The CALLER must surface
	 * these: a console warning is invisible, and the user sees "saved" while a
	 * link they just made silently did not travel. Typically a link to an
	 * element created locally and not yet uploaded.
	 */
	unresolvedLinks: string[];
	/**
	 * `[[Name]]` targets in a generic-target link field (a Pin's `element_id`)
	 * that matched notes of more than one type. Never guessed: the link is left
	 * out of `fields`, and the CALLER must name these to the user, as it does
	 * unresolvedLinks.
	 */
	ambiguousLinks: string[];
	/**
	 * A code fence in the body that never closes and swallows a `###`
	 * heading, read as its text (round C, 1): the field it opened in, as its
	 * heading reads, its line in the note, and the first heading it swallows.
	 * The CALLER refuses to send the note (readRefusal), never sends
	 * it cut short. An open fence that swallows no heading is not one (the fix
	 * round, item 1).
	 */
	unclosedFence?: { field: string; line: number; heading: string };
	/**
	 * Headings that start two sections of one field, a schema text field or a
	 * custom one (parseElementBody's `repeated`), each as first typed: `fields`
	 * holds only the last section's text. The CALLER refuses to send the note
	 * (readRefusal). A repeated heading that is prose, folded into
	 * the description with every section's text, is not one.
	 */
	repeatedHeadings?: string[];
	/**
	 * Frontmatter keys that are no field of the type, sent as `x_<key>`, that
	 * look like a slip for one of its link fields (round C, 4): the key and
	 * the field it likely meant. The CALLER names them; nothing is corrected.
	 */
	likelyMisnamed?: Array<{ key: string; field: string }>;
	/**
	 * The note carries `known_of: true` (or the known-of line): a stub of an
	 * element its reader knows of, its absent fields unknown, not empty (the
	 * folder spec §4.4). Never pushed.
	 */
	knownOf: boolean;
	/**
	 * The server's keys the note carries (SERVER_FIELDS: `created_at` to
	 * `changed_client`), as Download wrote them. Never in `fields`, so never
	 * sent; the folder export writes them back (3.10).
	 */
	serverFields: Record<string, unknown>;
	/**
	 * The note's `### Depends on` section holds lines a person wrote (any
	 * line but the generated ones): the section is not sent, so the CALLER
	 * names the note (dependsOnKeptMessage); the lines stay in the note and
	 * the next pull keeps them.
	 */
	dependsOnKept?: true;
	/**
	 * Names the note holds as a property of the person's own and again inside
	 * its own `x_properties` group: the note is refused by name (the Markdown
	 * profile, sentence 4), never sent with one of the two picked.
	 */
	ownConflicts?: string[];
	/**
	 * `x_` keys the note holds as a property and again as a `###` section, with different text (the Markdown profile, rule 11):
	 * the note is refused by name, never sent with one of the two picked. Two copies that are equal read as one.
	 */
	twinTexts?: string[];
}

/** Why a note with a name in both its properties and its `x_properties` is not sent (or `verb`). */
export function ownConflictMessage(name: string, names: string[], verb = "not sent"): string {
	const list = names.join(", ");
	return `${name} ${verb}: ${list} ${names.length === 1 ? "is" : "are"} both a property of the note and inside its x_properties. ` +
		"Keep one of them, then try again.";
}

/** "allies is not a field of Character; did you mean friends? Sent as x_allies." */
export function likelyMisnamedMessage(category: string, slips: Array<{ key: string; field: string }>): string {
	const type = category.charAt(0).toUpperCase() + category.slice(1);
	return slips
		.map((s) => `${s.key} is not a field of ${type}; did you mean ${s.field}? Sent in x_properties.`)
		.join(" ");
}

/** The adopted keys that look like a slip for a link field of `category`, as ParsedElement carries them. */
function misnamed(category: string, adopted: Array<{ from: string; to: string }>): { likelyMisnamed?: Array<{ key: string; field: string }> } {
	const slips: Array<{ key: string; field: string }> = [];
	for (const a of adopted) {
		const field = likelyLinkField(category, a.from);
		if (field) slips.push({ key: a.from, field });
	}
	return slips.length ? { likelyMisnamed: slips } : {};
}

/**
 * Why a note with an unclosed code fence is not sent (or changed, updated,
 * copied: `verb`): the field, the line, and the heading it swallows.
 */
export function unclosedFenceMessage(
	name: string,
	fence: { field: string; line: number; heading: string },
	verb = "not sent"
): string {
	return `${name} ${verb}: the code fence on line ${fence.line} (in ${fence.field}) never closes, ` +
		`so the heading "${fence.heading}" after it would be read as its text. ` +
		"Close the fence with a line of the same backticks or tildes, then try again.";
}

/**
 * Why a note readElement read is not sent (or copied, exported: `verdict`),
 * or null when its fields are the note's whole text: a code fence that never
 * closes, or a heading that starts two sections, each leaves `fields` holding
 * less than the note does. The one place every reader that sends, copies or
 * writes a note's fields asks: a new kind of loss is refused here, for all of
 * them. `outcome` is the command's own last sentence ("Nothing was sent."),
 * left out by a summary of many notes.
 */
export function readRefusal(
	parsed: Pick<ParsedElement, "unclosedFence" | "repeatedHeadings" | "twinTexts">,
	label: string,
	verdict = "not sent",
	outcome = ""
): string | null {
	if (parsed.unclosedFence) {
		const message = unclosedFenceMessage(label, parsed.unclosedFence, verdict);
		return outcome ? `${message} ${outcome}` : message;
	}
	if (parsed.repeatedHeadings?.length) return repeatedHeadingMessage(label, parsed.repeatedHeadings, verdict, outcome);
	if (parsed.twinTexts?.length) {
		const one = parsed.twinTexts.length === 1;
		const message = `${label} ${verdict}: ${parsed.twinTexts.join(", ")} ${one ? "is" : "are each"} both a property of the note and a ### section, with different text. Keep one of the two, then try again.`;
		return outcome ? `${message} ${outcome}` : message;
	}
	return null;
}

/**
 * A body's unclosed fence (parseElementBody) as the notice names it: the
 * field it opened in, its line in the whole note, and the heading it
 * swallows. `body` is the end of `content`. Save, Upload World, the folder
 * export, Manage Fields, Update World Format and Copy World all name it so.
 */
export function noteFence(
	content: string,
	body: string,
	category: string,
	fence: { heading: string | null; line: number; swallows: string }
): { field: string; line: number; heading: string } {
	return {
		field: fence.heading?.trim() || (bodyFieldForCategory(category) === "story" ? "Story" : "Description"),
		line: content.slice(0, content.length - body.length).split("\n").length - 1 + fence.line,
		heading: fence.swallows.trim(),
	};
}

/** Map a vault path to (worldName, category). Returns null if not an element. */
export function parseElementPath(path: string): { worldName: string; category: string } | null {
	const place = typeOfPlace(path);
	return place ? { worldName: place.worldName, category: place.type } : null;
}

/**
 * The world and type of an element note (the Markdown profile, sentences 1 and
 * 2): its place decides, the first folder below the world's folder named for
 * one of the 22; only a note outside every type folder is read by its `type`
 * property, and then only with an id that is a UUID. `World.md` and a note in
 * a dot-folder are no element's. `fm` is the note's front matter.
 */
export function elementNoteType(path: string, fm: Record<string, unknown> | null | undefined): { worldName: string; category: string } | null {
	const place = parseElementPath(path);
	if (place) {
		// Under Elements/ (this plugin's own folder) any id it ever wrote is the element's; in a type-named
		// folder anywhere else in the world only a UUID is, so a person's note with another plugin's id is theirs.
		return isUnderElements(path) || isElementId(fm?.id) ? place : null;
	}
	const parts = worldNotePath(path);
	if (!parts || inUnreadFolder(parts.folders)) return null;
	if (parts.folders.length === 0 && parts.file.toLowerCase() === "world.md") return null;
	if (!isElementId(fm?.id)) return null;
	const type = typeOfProperty(fm?.type);
	return type ? { worldName: parts.worldName, category: type } : null;
}

export { normalizeCategory };

/**
 * Schema-driven plural map used to derive SDK/v2 resource accessor name.
 * (Character -> characters, Species -> species, etc.)
 */
const PLURAL_OVERRIDES: Record<string, string> = {
	ability: "abilities",
	family: "families",
	phenomenon: "phenomena",
	species: "species",
};

export function categoryToResourceKey(category: string): string {
	const cat = normalizeCategory(category);
	return PLURAL_OVERRIDES[cat] ?? `${cat}s`;
}

/**
 * Read an element note. Prefers frontmatter (v2); falls back to the legacy span
 * body format so pre-migration notes still round-trip (R1). Returns null if the
 * note carries no recoverable id.
 *
 * Extension-namespaced frontmatter keys (atlas_/shadow_/x_) are preserved into
 * `fields` verbatim (R3), except a whole value of links to elements, which
 * reads back as their ids (3.13.0). The body becomes description (or story
 * for Narrative).
 *
 * Note: reliable frontmatter needs metadataCache to have indexed the file. When
 * a caller writes then immediately re-reads, the cache may lag; we fall back to
 * parsing the raw YAML block so reads are not cache-timing-dependent.
 */
export async function readElement(
	app: App,
	file: TFile,
	/**
	 * `fromBytes`: the note's front matter, and so its id and type, read from the
	 * bytes just read, never the metadata cache: a stale cache must never make a
	 * note of the person's own an element.
	 * `content`: the note's bytes as the caller already read them (Copy and
	 * Upload's one reading, worldElementNotesFromBytes): parsed instead of a
	 * second read, and read as `fromBytes` reads.
	 */
	opts: { fromBytes?: boolean; content?: string } = {}
): Promise<ParsedElement | null> {
	const content = opts.content ?? (await app.vault.read(file));
	const fromBytes = opts.fromBytes === true || opts.content !== undefined;

	// Frontmatter path: cache first, raw YAML fallback (cache-timing safety).
	let fm = fromBytes ? undefined : (app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined);
	if (!fm || typeof fm.id !== "string") {
		const raw = parseRawFrontmatter(content);
		if (raw && (fromBytes || typeof raw.id === "string")) fm = raw;
	}
	const pathInfo = elementNoteType(file.path, fm);
	if (!pathInfo) return null;
	const category = normalizeCategory(pathInfo.category);

	if (fm && typeof fm.id === "string") {
		// Not trimmed: the last section's value runs to the end of the note, and
		// its own trailing whitespace is part of it. What
		// sits between the `---` and the first heading is the preamble, which
		// parseElementBody keeps byte for byte too (round C, 2).
		// The separator joinNote writes, and only it: the `---` line's ending,
		// then one blank line. A body with no field heading is the description
		// itself, so nothing more of it is cut.
		// A known-of note's line is no part of any field.
		const knownOf = isKnownOfNote(content);
		const afterFm = stripFrontmatter(content).replace(/^\r?\n/, "").replace(/^\r?\n/, "");
		// Nor is the spine list's generated section: it is
		// the plugin's, taken out here before any field is read, so it is never
		// a field, never folded into the description, and never sent; the list
		// itself travels as the frontmatter holds it. A person's own lines in
		// it are no field either, but the caller says so (dependsOnKept).
		const depends = withoutDependsOn(knownOf ? withoutKnownOfLine(afterFm) : afterFm);
		const raw = depends.body;
		const dependsOnKept = dependsOnOwnText(depends.section) !== "";
		const body = raw.trim() ? raw : "";
		// Link fields may be readable `[[Name]]` wikilinks (R1). Resolve them to
		// ids path-awarely (getFirstLinkpathDest disambiguates same-name notes).
		// A bare-id link value passes through untouched (dangling/unmigrated).
		const unresolved: string[] = [];
		const ambiguous: string[] = [];
		const adopted: Array<{ from: string; to: string }> = [];
		const ownConflicts: string[] = [];
		// A Pin's `element_type` (a text field, so a body section) narrows its
		// generic `element_id` to that type's notes.
		const parsedBody = body ? parseElementBody(body, category) : null;
		const elementType = parsedBody?.fields.element_type;
		// The body is the end of the note, so its line 1 is the note's line
		// after everything before it.
		const fence = parsedBody?.unclosedFence;
		const unclosedFence = fence ? noteFence(content, body, category, fence) : undefined;
		const fields = frontmatterToPayloadFields(fm, category, {
			resolveNameToId: buildWikilinkResolver(app, file.path),
			unresolved,
			ambiguous,
			adopted,
			ownConflicts,
			genericTargetType: elementType || undefined,
			// Upload safety: a field with any unresolvable [[Name]] is OMITTED, not
			// shortened — a full-field bulk PATCH built from a reduced id list would
			// strip the server's copy of the dropped link (the 2.3.0 smoke class,
			// audit finding 2026-07-17). The server value wins until the link
			// resolves locally.
			omitFieldOnUnresolved: true,
		});
		if (unresolved.length > 0) {
			// Never silent (round-trip law): a `[[Name]]` link that resolves to no
			// note is dropped from THIS read's field set (the field is omitted so the
			// server value is preserved), logged so the loss is visible.
			console.warn(
				`[OnlyWorlds] ${file.path}: ${unresolved.length} unresolved link(s); their fields omitted from upload to preserve server values: ${unresolved.join(", ")}`
			);
		}
		// v3.2: the body carries text fields as `### Heading` sections (only that
		// level is a field boundary; `#`, `##`, `####`+ stay prose). Unknown
		// headings and any preamble are folded back into description/story rather
		// than dropped (never-drop, R2) — a user who renames a heading loses no
		// prose. A legacy body with no headings at all parses to a lone preamble,
		// which lands in the body field exactly as it did before.
		let repeatedHeadings: string[] = [];
		const twinTexts: string[] = [];
		if (body) {
			// A `### Looks` section is a user-added custom TEXT field and must reach
			// the API as `x_looks`, not be salvaged into description. We cannot know
			// from the note alone which unknown headings are deliberate, so treat
			// every unknown heading whose name is a clean single token as a custom
			// field. A heading with punctuation or many words reads as prose
			// structure and still falls through to the never-drop salvage.
			//
			// ⚑ A note an older plugin wrote may carry a section copy of a tool's
			// key (`atlas_color` in frontmatter, `### Color` in the body). That
			// section is the tool's value, not a user field: it is consumed here,
			// read neither as `x_color` nor as prose, and the next write drops it.
			// The user's own `x_color` in the frontmatter still claims the heading.
			const toolShadows = toolShadowHeadings(fm);
			const unknownHeadings = (parsedBody ?? parseElementBody(body, category)).unknown.map((u) => u.heading.trim());
			const customKeys = unknownHeadings
				.filter((h) => readsAsCustomField(h))
				.map((h) => `x_${headingToFieldKey(h)}`)
				// `### Properties` is prose, never the group's key: a section must not replace the person's own properties.
				.filter((k) => k !== OWN_PROPERTIES_KEY)
				.filter((k) => !toolShadows.has(k) || k in fm);
			const shadowKeys = [...toolShadows].filter((k) => !(k in fm));
			const sectionValues = bodyToFieldValues(body, category, [...customKeys, ...shadowKeys]);
			for (const k of shadowKeys) delete sectionValues[k];
			for (const [k, v] of Object.entries(sectionValues)) {
				// The note's own copy of the key, a property: equal reads as one, different is refused by name (the section is what is sent).
				const property = fm[k];
				if (isUserCustomKey(k) && typeof property === "string" && property.trimEnd() !== v.trimEnd()) twinTexts.push(k);
				fields[k] = v;
			}
			// A heading read as a field, typed twice: only its last section would travel.
			const textKeys = new Set(bodyTextFields(category));
			repeatedHeadings = (parsedBody?.repeated ?? []).filter((h) => {
				const key = headingToFieldKey(h);
				return textKeys.has(key) || customKeys.includes(`x_${key}`);
			});
		}
		if (!fields.name) {
			fields.name = typeof fm.name === "string" ? fm.name : file.basename;
		}
		return {
			id: fm.id,
			name: String(fields.name),
			category,
			worldName: pathInfo.worldName,
			fields,
			unresolvedLinks: unresolved,
			ambiguousLinks: ambiguous,
			...(unclosedFence ? { unclosedFence } : {}),
			...(repeatedHeadings.length ? { repeatedHeadings } : {}),
			...(twinTexts.length ? { twinTexts } : {}),
			...misnamed(category, adopted),
			...(ownConflicts.length ? { ownConflicts: [...new Set(ownConflicts)] } : {}),
			knownOf,
			serverFields: serverFieldsOf(fm),
			...(dependsOnKept ? { dependsOnKept: true as const } : {}),
		};
	}

	// Legacy span-format fallback (pre-migration notes): only a note in the old
	// layout and nothing else (isOldSpanNote); any other note is the person's own.
	if (isOldSpanNote(content)) {
		const parsed = parseSpanNote(content);
		if (!parsed.id) return null;
		const resolver = buildVaultLinkResolver(app, pathInfo.worldName);
		const { frontmatter, bodyValue } = spanFieldsToFrontmatter(parsed, category, resolver);
		const fields = frontmatterToPayloadFields(frontmatter, category);
		const bodyField = bodyFieldForCategory(category);
		if (bodyValue) fields[bodyField] = bodyValue;
		if (!fields.name) fields.name = parsed.name ?? file.basename;
		return {
			id: parsed.id,
			name: String(fields.name),
			category,
			worldName: pathInfo.worldName,
			fields,
			unresolvedLinks: [],
			ambiguousLinks: [],
			knownOf: false,
			serverFields: {},
		};
	}

	return null;
}

/**
 * Write/update an element note in v2 frontmatter format.
 *
 * `data` is API-shaped (snake_case fields, link fields as ids). Extension keys
 * in `data` round-trip verbatim (R3). The body holds description/story (R5).
 * Atomic frontmatter via processFrontMatter; body written separately.
 *
 * Returns the file. `markSelfWrite` (if provided) is called with the path before
 * each disk write so the auto-sync modify listener skips our own writes.
 *
 * `opts.folderPath` lets a caller pass a pre-resolved category folder (which in
 * a real world carries a count suffix, e.g. "Character (12)") so writes don't
 * split off a bare "Character" folder. `opts.fileName` overrides the leaf name
 * (used for collision-suffixed unique names). Both are optional; without them
 * writeElement targets the bare-named folder / sanitized element name.
 */
export interface WriteElementOpts {
	markSelfWrite?: (path: string) => void;
	/**
	 * Write the element's FULL field set, empty fields included (v3.2 scaffold).
	 * Set by element CREATION so a new note shows every field it can carry;
	 * downloads leave it off so a note shows what the element actually has.
	 */
	scaffoldEmptyFields?: boolean;
	folderPath?: string; // e.g. "OnlyWorlds/Worlds/W/Elements/Character (12)"
	fileName?: string; // e.g. "Ireena (2).md"
	/**
	 * Pre-built id -> display-name resolver (R1). When present, link ids render as
	 * `[[Name]]` wikilinks against THIS map instead of the metadataCache-scanning
	 * buildIdToNameResolver. A caller mid-bulk-write (DownloadWorldCommand) supplies
	 * a map built from the in-memory payload (+ raw-disk fallback) because the cache
	 * is cold for freshly-written sibling notes — that stale cache is the S9 bug.
	 * Absent -> today's buildIdToNameResolver behavior (back-compat for Create/Import).
	 */
	idToName?: (id: string) => string | null;
	/**
	 * Id -> the element's own name, for the `### Depends on` lines: where it
	 * differs from the note's name in `idToName` (a name a file name cannot
	 * hold), the line shows it as `[[note|name]]`. Absent -> plain lines.
	 */
	idToRealName?: (id: string) => string | null;
	/**
	 * Text written above the first field section, as it is: the person's
	 * writing a hidden element's stub kept, when Download writes that note in
	 * full again, back where it came from, so a later save folds it into the
	 * description as any loose prose (ruled 2026-10-20). Part of the one write.
	 */
	keepAbove?: string;
	/**
	 * Write the element as a known-of stub (the folder spec §4.4 rule 1):
	 * `known_of: true` and only the keys whose values are set,
	 * every unset field left out (no scaffold, no empty section), the known-of
	 * line above the fields. Without it, `known_of` never survives a write: a
	 * stub that arrives whole is written whole (rule 4).
	 */
	knownOf?: boolean;
	/**
	 * The note the caller's plan already found for this element (a pull plans
	 * every note before it writes any): the write goes there with no scan of the
	 * world's notes. `null`: the plan found none. Absent: the writer looks by id.
	 */
	existingPath?: string | null;
	/**
	 * Properties of the note the world's group held and no longer holds, unchanged since (removedGroupKeys,
	 * note-mark-core.ts): they leave the note with the write, where every other property of a person's stays.
	 */
	dropKeys?: string[];
	/**
	 * Called with the note's bytes just before the write replaces them (not called when the write changes nothing). The write
	 * then replaces exactly those bytes or none: a note that changed after this call is handed to it again (replaceNote).
	 */
	beforeReplace?: (content: string) => Promise<void>;
	/**
	 * Save the note's open editors before the write reads it and before each try (flushOpenEditors). Download only: a pull
	 * writes the server's bytes, so the save auto-sync schedules from the flush's modify event finds nothing to send. A writer
	 * of bytes the server does not hold (Paste world) must not flush: that save would send them.
	 */
	flushEditors?: boolean;
	/**
	 * Build the note as this write would leave it and return those bytes (`WrittenNote.text`), writing, making and copying
	 * nothing: `renderElementNote` only. The note must exist; with none this throws.
	 */
	dryRender?: boolean;
}

/**
 * The note a write left: its file, and the bytes the writer put there (or found and left, when nothing needed to change), the
 * measure of what a person types after it. `text` is null when the note changed under each try and was left as the person has it.
 */
export interface WrittenNote {
	file: TFile;
	text: string | null;
	/** A dry render only: the bytes of the note the render was made over, read in the same call. */
	read?: string;
}

/**
 * Save every open editor of `file` to disk. Obsidian writes an editor's text about two seconds after the last key, and
 * `vault.read` and `vault.process` see the disk only: typing not yet saved would be in no copy, and the write's reload of the
 * editor would end it. Saved first, it is on disk, no longer hashes to the note's mark, and the copy rule keeps it.
 *
 * Only a dirty view of this file is saved: one whose text (`getViewData`) differs from the file's, line endings aside (an
 * editor that holds `\n` where the file holds `\r\n` has nothing unsaved). A clean view, a view with no `save` or no text, and
 * a workspace that lists no leaves are passed over. The save is a plain one, the person's own, with no self-write mark: its
 * modify event schedules auto-sync's save as any edit does. Only a pull flushes (WriteElementOpts.flushEditors): it writes the
 * server's bytes, so that save then finds nothing to send; with no write after it, the typing is sent as any edit is.
 *
 * A save that does not return within FLUSH_SAVE_TIMEOUT.ms throws, so the writer leaves that note as it was and says so; a
 * save that completes later is the person's own. Nothing here swallows an error.
 */
export async function flushOpenEditors(app: App, file: TFile): Promise<void> {
	const workspace = app.workspace as { getLeavesOfType?: (type: string) => { view: unknown }[] } | undefined;
	if (typeof workspace?.getLeavesOfType !== "function") return;
	for (const leaf of workspace.getLeavesOfType("markdown")) {
		const view = leaf.view as { file?: TFile | null; save?: () => Promise<void>; getViewData?: () => unknown } | undefined;
		if (view?.file?.path !== file.path || typeof view.save !== "function") continue;
		const held = typeof view.getViewData === "function" ? view.getViewData() : null;
		if (typeof held !== "string") continue;
		if (held.replace(/\r\n/g, "\n") === (await app.vault.read(file)).replace(/\r\n/g, "\n")) continue;
		await savedWithin(view.save(), FLUSH_SAVE_TIMEOUT.ms);
	}
}

/** How long the flush waits for an editor's save (a test may shorten it). */
export const FLUSH_SAVE_TIMEOUT = { ms: 5000 };

function savedWithin(save: Promise<void>, ms: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`the open editor did not save its text within ${Math.round(ms / 100) / 10} s`)), ms);
	});
	return Promise.race([save, late]).finally(() => clearTimeout(timer));
}

/** How many times a write meets a note changed since it last read it before it leaves the note as the person has it. */
export const REPLACE_TRIES = 3;

/**
 * Replace the bytes `seen` of a note with `next` in one atomic read-modify-write (`vault.process`): the write goes through only
 * when the note still holds the bytes last handed to `beforeReplace`, so text a person types after that (while a copy of the note
 * is written, or before the write) is in the copy or stays in the note, never in neither. A note found changed is handed to
 * `beforeReplace` again, then tried again, up to REPLACE_TRIES times. `ownBytes` are bytes the writer itself just put there
 * (a note it made): no one's edit, so they are not handed over. The self-write mark is taken inside the write, only when the
 * write happens. Returns `next`, or null when the note was left as the person has it.
 */
export async function replaceNote(
	app: App,
	file: TFile,
	seen: string,
	next: string,
	opts: { beforeReplace?: (content: string) => Promise<void>; markSelfWrite?: (path: string) => void; ownBytes?: string; flushEditors?: boolean } = {}
): Promise<string | null> {
	let expected = seen;
	for (let i = 0; i < REPLACE_TRIES; i++) {
		// An editor's unsaved text reaches the disk first; the write then finds the note changed and copies it.
		if (opts.flushEditors) await flushOpenEditors(app, file);
		if (expected === next) return next;
		if (expected !== opts.ownBytes) await opts.beforeReplace?.(expected);
		// And again right before the write: typing in the editor while the copy was written reaches the disk, the comparison
		// below sees it, and the try repeats with a fresh copy.
		if (opts.flushEditors) await flushOpenEditors(app, file);
		const found: { text: string | null } = { text: null };
		await app.vault.process(file, (current) => {
			if (current !== expected) {
				found.text = current;
				return current;
			}
			opts.markSelfWrite?.(file.path);
			return next;
		});
		if (found.text === null) return next;
		expected = found.text;
	}
	return null;
}

/** writeElement, and the bytes the write left (WrittenNote): the caller's mark of the note is the hash of those, never a later read. */
export async function writeElementNote(
	app: App,
	worldName: string,
	category: string,
	elementId: string,
	data: Record<string, unknown>,
	optsOrMark?: WriteElementOpts | ((path: string) => void)
): Promise<WrittenNote> {
	// Back-compat: a bare function arg is markSelfWrite.
	const opts: WriteElementOpts =
		typeof optsOrMark === "function" ? { markSelfWrite: optsOrMark } : optsOrMark ?? {};
	const markSelfWrite = opts.markSelfWrite;
	const knownOf = opts.knownOf === true;
	// A stub keeps what it carries and nothing it leaves unset (rule 1).
	if (knownOf) data = knownOfKept(data);
	const cat = normalizeCategory(category);
	const folderName = capitalize(cat);
	const name = typeof data.name === "string" && data.name ? data.name : "Untitled";
	// MUST be the SAME transform DownloadWorldCommand.buildIdToNameMap applies to
	// wikilink targets — otherwise a name with a trailing dot/control char names
	// the file one way and the [[link]] another, and the link dangles (gate
	// finding, 2026-07-16: safeName was a weaker regex than sanitizeFileName).
	const safeName = sanitizeFileName(name);
	const bodyField = bodyFieldForCategory(cat);
	// v3.2: the body is no longer just description/story — it carries EVERY text
	// field as a `## Heading` section, empty ones included (the empty section is
	// the scaffold that makes a field discoverable at all). Custom `x_` text
	// fields ride along, rendered without their prefix.
	// Only `x_` keys, the user's own custom fields. Any
	// other namespace (`atlas_`, `shadow_`) is a tool's: it stays in the
	// frontmatter verbatim, never becomes a section, and so is never read back
	// as an `x_` copy of itself (`atlas_color` -> `### Color` -> `x_color`).
	// `x_depends_on` is never a section: its heading is the generated
	// section's, which no reader reads. An element that
	// carries one keeps it in the frontmatter, verbatim, as any extension key.
	const customTextFields = Object.entries(data)
		.filter(([k, v]) => writesAsSection(k, v, cat))
		.map(([k]) => k);

	const folder = opts.folderPath
		? normalizePath(opts.folderPath)
		: `OnlyWorlds/Worlds/${worldName}/Elements/${folderName}`;
	const leaf = opts.fileName ? opts.fileName.replace(/\.md$/i, "") + ".md" : `${safeName}.md`;

	// Resolve target path BY ID first: reuse an existing note with this id if
	// present (so a rename on the server moves the file rather than orphaning
	// it). Only when no note carries this id does the NAME pick the path — and
	// then never a path another element already holds (see claimNotePath).
	const planned = opts.existingPath;
	let existing: TFile | null =
		planned === undefined
			? await findNoteById(app, worldName, folderName, elementId)
			: planned
				? (app.vault.getAbstractFileByPath(planned) as TFile | null)
				: null;
	// The plan's note is gone (moved or deleted since the plan) or is no longer this element's: look by id, as the writer always did.
	if (planned && !(existing instanceof TFile && (await noteIdOf(app, existing)) === elementId)) {
		existing = await findNoteById(app, worldName, folderName, elementId);
	}
	const filePath = existing
		? existing.path // keep the existing file; rename is a separate concern
		: await claimNotePath(app, folder, leaf.replace(/\.md$/i, ""), elementId);

	let file = app.vault.getAbstractFileByPath(filePath);
	let made: string | undefined; // the bytes of a note this write just made: no one's edit, so no copy is asked for them
	if (!(file instanceof TFile)) {
		if (opts.dryRender) throw new Error(`no note at ${filePath} to render over`);
		if (!app.vault.getAbstractFileByPath(folder)) {
			await app.vault.createFolder(folder);
		}
		markSelfWrite?.(filePath);
		made = `---\nid: ${elementId}\n---\n\n`;
		file = await app.vault.create(filePath, made);
	}
	if (!(file instanceof TFile)) throw new Error(`Could not create the element file at ${filePath}`);

	// R1: render link ids as [[Name]] wikilinks. Prefer a caller-supplied map
	// (payload-derived, cache-independent — the S9 fix) over the cache-scanning
	// resolver, which is unreliable mid-bulk-write (freshly-written siblings are
	// not yet indexed in metadataCache).
	const resolveId = opts.idToName ?? buildIdToNameResolver(app, worldName);
	const built = apiDataToFrontmatter(data, cat, elementId, {
		resolveIdToName: resolveId,
		resolveIdToRealName: opts.idToRealName,
		scaffoldEmptyFields: knownOf ? false : opts.scaffoldEmptyFields,
	});
	// The mark sits under the id, where the Properties panel shows it first;
	// the stub's base keys follow, written even when empty, as the reference
	// writers write them.
	let fm: Record<string, unknown> = built;
	if (knownOf) {
		fm = { name: built.name, id: built.id, [KNOWN_OF_KEY]: true };
		for (const k of ["supertype", "subtype", "image_url"]) {
			if (k in data) fm[k] = k in built ? built[k] : data[k];
		}
		for (const [k, v] of Object.entries(built)) if (!(k in fm)) fm[k] = v;
	}

	// ★ ONE write for the whole note — frontmatter AND body together.
	//
	// This used to be two steps: processFrontMatter for the block, then a
	// vault.modify for the body. That is what corrupted notes (2026-08-22,
	// reproduced on four real notes): processFrontMatter is async and owns the
	// serialization, and on a note whose body was empty it left blank lines
	// above the `---`. A block that is not at byte 0 is not frontmatter to
	// Obsidian — the note renders as plain text and every later write buries it
	// deeper. Chasing it with a repair pass afterwards kept losing the race.
	//
	// Serializing the block ourselves removes the whole class: there is exactly
	// one write, it is built by joinNote, and joinNote cannot emit a leading
	// blank line. We also keep any frontmatter key we do not own (extension
	// namespaces, the user's own additions), which is what processFrontMatter
	// was buying us.
	// An open editor's unsaved text is saved first, so this read (and the copy of it) holds it (a pull's writes only).
	if (opts.flushEditors && !opts.dryRender) await flushOpenEditors(app, file);
	const content = await app.vault.read(file);
	const existingFm = parseRawFrontmatter(content) ?? {};
	const schema = getCategorySchema(cat);
	// `known_of` and its record are the writer's alone: set on a stub, gone on a whole write.
	// The server's seven are the arriving element's (3.10): one the server
	// now serves null (a former member's `changed_by` after the owner's
	// edit) leaves the note, never kept from the last pull.
	const ownedKeys = new Set<string>(["id", "name", KNOWN_OF_KEY, KNOWN_OF_WRITTEN_KEY, ...SERVER_FIELDS]);
	// The note's own `x_properties` (entries the pull kept there, or typed by hand) is the server's to replace only when the
	// element arrives with a group; with none it stays, and the next save sends it.
	if (OWN_PROPERTIES_KEY in data) ownedKeys.add(OWN_PROPERTIES_KEY);
	if (schema) for (const k of Object.keys(schema)) ownedKeys.add(k);
	// A section-only key (writesAsSection) is the section's: an old note's property copy of it goes with this write.
	for (const k of customTextFields) ownedKeys.add(k);
	const preserved: Record<string, unknown> = {};
	// A stub replacing a whole copy (a view reset) keeps none of its extension
	// values: they are the element's, and a stub carries only what it keeps.
	// Over a known-of note, what the last stub wrote goes, by its record, and
	// what the person added stays. A known-of
	// note with no record (made by hand) keeps every extension key: nothing on
	// it is known to be the stub's.
	const state = noteStateOf(content);
	const replacesWhole = knownOf && state === "whole";
	const written = state === "known_of" ? knownOfRecord(existingFm) : null;
	for (const [k, v] of Object.entries(existingFm)) {
		if (replacesWhole && isExtensionKey(k)) continue;
		if (written?.includes(k)) continue;
		if (opts.dropKeys?.includes(k)) continue;
		if (!ownedKeys.has(k)) preserved[k] = v;
	}
	const merged: Record<string, unknown> = { ...fm };
	for (const [k, v] of Object.entries(preserved)) {
		if (!hasOwn(merged, k)) merged[k] = v;
	}
	// A note outside every type folder is of the type its `type` property names: a `type` entry in the server's group
	// (written from another place, where the note sits in a type folder) cannot be that property. The note keeps its
	// type, and the entry stays in the note's own group, so the next save sends it back with the rest.
	const serverGroup = data[OWN_PROPERTIES_KEY];
	if (!typeOfPlace(filePath) && existingFm.type !== undefined) {
		merged.type = existingFm.type;
		if (serverGroup && typeof serverGroup === "object" && !Array.isArray(serverGroup) && "type" in serverGroup) {
			const held = merged[OWN_PROPERTIES_KEY];
			merged[OWN_PROPERTIES_KEY] = {
				...(held && typeof held === "object" && !Array.isArray(held) ? (held as Record<string, unknown>) : {}),
				type: (serverGroup as Record<string, unknown>).type,
			};
		}
	}
	// The server's keys close the block, after a person's own keys too (`tags`, a note's `type`): where a save's refresh puts
	// them (withServerFieldLines), so the render of a saved note is the note and not the same lines in another order.
	for (const k of SERVER_FIELDS) {
		if (!hasOwn(merged, k)) continue;
		const held = merged[k];
		delete merged[k];
		merged[k] = held;
	}
	// The record goes last, under everything the person reads first.
	if (knownOf) merged[KNOWN_OF_WRITTEN_KEY] = knownOfWritten(data, cat);
	// The person's own sections of a known-of note follow the fields, byte for
	// byte, whether the stub arrives again or whole. An own
	// section headed as a field the element leaves unset stands for that
	// field: the field is not written a second, empty time (N4).
	const held = heldHeadingsOf(splitNote(content).body);
	const own = knownOfOwnSections(content, cat, data, written);
	const bodyValue = knownOf
		? buildElementBody(data, cat, customTextFields, bodyTextFields(cat).filter((k) => k in data && !own.fields.includes(k)), held)
		: own.fields.length
			? buildElementBody(data, cat, customTextFields, bodyTextFields(cat).filter((k) => !own.fields.includes(k)), held)
			: buildElementBody(data, cat, customTextFields, undefined, held);
	const above = opts.keepAbove ?? "";
	// The kept text, then one blank line before the first heading.
	const gap = !above || above.endsWith("\n\n") ? "" : above.endsWith("\n") ? "\n" : "\n\n";
	// A stub with no field to show is the line and the person's writing alone.
	let sections = bodyValue ? `${above}${gap}${bodyValue}\n` : above;
	if (own.text) sections = `${sections}${!sections || sections.endsWith("\n\n") ? "" : sections.endsWith("\n") ? "\n" : "\n\n"}${own.text}`;
	let body = knownOf ? `${KNOWN_OF_LINE}\n${sections ? `\n${sections}` : ""}` : sections;
	// The spine list's generated section, last: written from
	// the arriving element's list, never from the note's last one, so a list
	// that became empty or left the element takes its lines with it. The body
	// is rebuilt from `data` (a known-of note's own sections skip the section,
	// knownOfOwnSections); what a person wrote under the heading is the one
	// part of the last section kept, after the list, so it is never erased.
	const ownDepends = dependsOnOwnText(withoutDependsOn(splitNote(content).body).section);
	const depends = dependsOnSection(data[DEPENDS_ON_KEY], resolveId, ownDepends, opts.idToRealName);
	if (depends) body = `${withDependsOn(body, depends)}\n`;
	const newContent = joinNote(serializeFrontmatter(merged), body);
	if (opts.dryRender) return { file, text: newContent, read: content };
	// The bytes about to be replaced, as this write read them, go to the caller first (the pull's copy of a note that held edits
	// it had not seen); the write then replaces those bytes or none (replaceNote).
	const text = await replaceNote(app, file, content, newContent, { beforeReplace: opts.beforeReplace, markSelfWrite, ownBytes: made, flushEditors: opts.flushEditors });
	return { file, text };
}

/**
 * What a pull would write to the note at `path` from `data` (the element as the world holds it): the writer's own render, run
 * with no write, and `read`, the note's bytes it was made over (read in the same call, so no later read stands in for them). A
 * note a Save leaves is the world's copy exactly when `text === read`, and only then may it be marked as such. Null when no
 * render could be made (no note at `path`, another note taking the id, a throw): never read as a match.
 */
export async function renderElementNote(
	app: App,
	worldName: string,
	category: string,
	elementId: string,
	data: Record<string, unknown>,
	path: string,
	opts: Pick<WriteElementOpts, "scaffoldEmptyFields" | "idToName" | "idToRealName"> = {}
): Promise<{ text: string; read: string } | null> {
	try {
		const out = await writeElementNote(app, worldName, category, elementId, data, { ...opts, existingPath: path, dryRender: true });
		if (out.text === null || out.read === undefined || out.file.path !== path) return null;
		return { text: out.text, read: out.read };
	} catch (error) {
		console.error(`OnlyWorlds: could not render ${path} as the world holds it`, error);
		return null;
	}
}

/**
 * Write/update an element note (writeElementNote), returning its file. A note that changed under every try of the write is left
 * as the person has it, and this throws, saying so.
 */
export async function writeElement(
	app: App,
	worldName: string,
	category: string,
	elementId: string,
	data: Record<string, unknown>,
	optsOrMark?: WriteElementOpts | ((path: string) => void)
): Promise<TFile> {
	const wrote = await writeElementNote(app, worldName, category, elementId, data, optsOrMark);
	if (wrote.text === null) throw new Error(`${wrote.file.path} was not written: it changed each time it was about to be, so it was left as it is`);
	return wrote.file;
}

/**
 * The id of every element note in the world's folder, to its path, read
 * from disk (the cache is cold mid-download): Download's and Paste world's one
 * lookup of "does this element have a note", wherever the note sits. The
 * frontmatter `id:` is read first, then an old span note's Id line under
 * Elements/ (noteIdIn). Only an element note counts (the rule Save uses): a
 * person's own note, or a copy with no type outside the type folders, is never
 * a note they write to. All the notes holding an id are kept; the caller picks
 * one by `pickNoteForId`, the same rule the writer uses.
 */
export async function worldNoteIds(app: App, worldName: string): Promise<Map<string, string[]>> {
	const index = new Map<string, string[]>();
	for (const file of app.vault.getMarkdownFiles()) {
		if (!mayBeElementNote(file.path, worldName)) continue;
		try {
			const content = await app.vault.read(file);
			let id: string | undefined;
			// The note's own YAML, as Save reads it, so the plan and Save cannot disagree about a note (a comment on the
			// id line, flow style, a quoted key); the line scan only where the YAML is not readable.
			const yaml = parseRawFrontmatter(content);
			const fm = yaml && typeof yaml.id === "string" ? yaml : parseRawFrontmatterScalars(content, ["id", "type"]);
			if (typeof fm.id === "string" && fm.id) {
				if (elementNoteType(file.path, fm)) id = fm.id;
			} else if (isUnderElements(file.path) && typeOfPlace(file.path)) {
				// The plugin's own folders: an old span note's Id line, read as the writer reads it (noteIdIn:
				// a note in the old layout and nothing else). A line of a person's writing that looks like an
				// id (`- **ID:** …`, which no plugin version wrote into an element note) is never taken for one.
				id = noteIdIn(content) ?? undefined;
			}
			if (id) index.set(id, [...(index.get(id) ?? []), file.path]);
		} catch (error) {
			console.error(`Error reading element file: ${file.path}`, error);
		}
	}
	return index;
}

// --- helpers -----------------------------------------------------------------

/** Parse a raw `---\n...\n---` YAML block (cache-independent read fallback). */
export function parseRawFrontmatter(content: string): Record<string, unknown> | null {
	if (!content.startsWith("---")) return null;
	const close = frontmatterClose(content);
	if (!close) return null;
	const yaml = content.slice(3, close.end + 1);
	try {
		const parsed = parseYaml(yaml);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * The id a note's front matter holds, as the YAML reader reads it: a quoted
 * key (`"id": …`), a comment after the value and any quoting are the
 * reader's to settle, not a line scan's. When the block does not parse, the
 * line scan's reading, so a note with a broken block and an `id` line still
 * counts as a note with an id (never as an old span note). Null when the
 * note's front matter holds no id.
 */
export function ownFrontmatterId(content: string): string | null {
	const block = splitNote(content).frontmatter;
	if (!block) return null;
	const fm = parseRawFrontmatter(block);
	if (!fm) return parseRawFrontmatterScalars(block, ["id"]).id ?? null;
	const id = fm.id;
	if (typeof id === "string") return id.trim() ? id : null;
	return typeof id === "number" ? String(id) : null;
}

/**
 * A note's front matter block with the person's own lines kept as they wrote
 * them: the keys in `drop` are removed, `first` is written before the kept
 * lines and `last` after them (a key in either replaces the line of that
 * name). Every other line, its spelling, quoting, comments and order, stays as
 * it is, so a date stays `2024-01-01`, a block string stays a block, `.inf`
 * stays `.inf`, whatever the YAML reader makes of them.
 *
 * `block` is the note's `---` block, or "" for a note with none. Returns null
 * when the lines cannot be told apart by key (a top-level line that is not a
 * key, two keys on one line), or when reading the result back does not give
 * each kept property its old value: the caller then writes the whole block.
 */
export function editFrontmatterLines(
	block: string,
	drop: Iterable<string>,
	first: Record<string, unknown>,
	last: Record<string, unknown>
): string | null {
	const inner = (o: Record<string, unknown>): string[] => (Object.keys(o).length ? serializeFrontmatter(o).split("\n").slice(1, -1) : []);
	const dropList = [...drop];
	if (!block.trim()) {
		const lines = [...inner(first), ...inner(last)];
		return lines.length ? ["---", ...lines, "---"].join("\n") : "";
	}
	// Nothing to change: the block as it is, whatever form it takes.
	if (dropList.length === 0 && Object.keys(first).length === 0 && Object.keys(last).length === 0) return block.replace(/(\r?\n)+$/, "");
	const eol = block.includes("\r\n") ? "\r\n" : "\n";
	const lines = block.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	if (lines.length < 2 || lines[0].trimEnd() !== "---" || lines[lines.length - 1].trimEnd() !== "---") return null;
	const head: string[] = [];
	const tail: string[] = [];
	const entries: Array<{ key: string; lines: string[] }> = [];
	for (const line of lines.slice(1, -1)) {
		// A key starts at the line's first character; indented lines and list items belong to the entry above.
		if (/^[^\s#]/.test(line) && !/^-(\s|$)/.test(line)) entries.push({ key: "", lines: [line] });
		else if (entries.length) entries[entries.length - 1].lines.push(line);
		else head.push(line);
	}
	// A comment (or blank line) after an entry's own lines belongs to the key below it: it stays when the entry above goes.
	for (let i = 0; i < entries.length; i++) {
		const own = entries[i].lines;
		let cut = own.length;
		while (cut > 1 && (own[cut - 1].trim() === "" || own[cut - 1].startsWith("#"))) cut--;
		const moved = own.splice(cut);
		if (i + 1 < entries.length) entries[i + 1].lines.unshift(...moved);
		else tail.push(...moved);
	}
	for (const e of entries) {
		const one = parseRawFrontmatter(`---\n${e.lines.join("\n")}\n---`);
		const keys = one ? Object.keys(one) : [];
		if (keys.length !== 1) return null;
		e.key = keys[0];
	}
	const replaced = new Set<string>([...dropList, ...Object.keys(first), ...Object.keys(last)]);
	const kept = entries.filter((e) => !replaced.has(e.key));
	// A dropped entry's comment lines stay where they were; only its key and value go.
	const body = entries.flatMap((e) => (replaced.has(e.key) ? e.lines.filter((l) => l.startsWith("#")) : e.lines));
	const out = ["---", ...head, ...inner(first), ...body, ...tail, ...inner(last), "---"].join(eol);
	// The check: every kept property reads back as it read before, and nothing else came or went.
	const before = parseRawFrontmatter(block.replace(/\n+$/, "")) ?? {};
	const after = parseRawFrontmatter(out);
	if (!after) return null;
	const want = new Set<string>([...kept.map((e) => e.key), ...Object.keys(first), ...Object.keys(last)]);
	if (Object.keys(after).some((k) => !want.has(k))) return null;
	for (const e of kept) {
		if (!hasOwn(after, e.key) || !sameYamlValue(before[e.key], after[e.key])) return null;
	}
	return out;
}

/** Two values a YAML reader made are the same value: dates by their time, NaN as NaN, lists and maps entry by entry. */
function sameYamlValue(a: unknown, b: unknown): boolean {
	if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	if (typeof a === "number" && typeof b === "number") return Object.is(a, b) || a === b;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameYamlValue(x, b[i]));
	}
	if (a && b && typeof a === "object" && typeof b === "object") {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		return ka.length === kb.length && ka.every((k) => hasOwn(b, k) && sameYamlValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
	}
	return a === b;
}

/**
 * The path for an element whose note was not found by id: `<base>.md`, unless a
 * DIFFERENT element (or any id-less note) already holds it — then the next free
 * `<base> (N).md`, N from 1, the collision convention create/download/paste
 * already use (WorldService.generateUniqueFileName).
 *
 * ★ Without this, two elements of one type sharing a name shared ONE note: the
 * second write overwrote the first and the folder import still counted both as
 * created (hop 9, 2026-09-23 — silent whole-element loss).
 *
 * A path already holding THIS element's id is reused: the id is read from the
 * file itself, because findNoteById goes through metadataCache, which is cold
 * for notes written moments ago in the same bulk run. Occupancy is compared
 * case-insensitively — on Windows and macOS `Guard.md` and `guard.md` are one
 * file, and Obsidian refuses to create the second.
 */
async function claimNotePath(app: App, folder: string, base: string, elementId: string): Promise<string> {
	const siblings = new Map<string, TFile>();
	const parent = app.vault.getAbstractFileByPath(folder);
	if (parent instanceof TFolder) {
		for (const c of parent.children) if (c instanceof TFile) siblings.set(c.path.toLowerCase(), c);
	}
	for (let n = 0; n <= 1000; n++) {
		const candidate = normalizePath(`${folder}/${n === 0 ? base : `${base} (${n})`}.md`);
		const exact = app.vault.getAbstractFileByPath(candidate);
		const occupant = exact instanceof TFile ? exact : siblings.get(candidate.toLowerCase());
		if (!exact && !occupant) return candidate;
		if (occupant && (await noteIdOf(app, occupant)) === elementId) return occupant.path;
	}
	// Never fall back to overwriting: a thrown write is reported as failed.
	throw new Error(`No free note name for "${base}" in ${folder}`);
}

/** The element id a note carries on disk: its front matter's, else an old span note's (noteIdIn). */
async function noteIdOf(app: App, file: TFile): Promise<string | null> {
	let content: string;
	try {
		content = await app.vault.read(file);
	} catch {
		return null;
	}
	return noteIdIn(content);
}

/**
 * The element id a note's bytes carry: its front matter's `id`, else the Id
 * line of an old span note (only a note in the old layout and nothing else:
 * isOldSpanNote), else none. A `- **ID:**` line is no id: no version of the
 * plugin, and no upstream template it fetched, wrote one into an element note
 * (World.md's `- **Id:**` line is the world's), so in a note it is the
 * person's own writing, and a pull or a paste must never take the note for
 * the element's.
 */
export function noteIdIn(content: string): string | null {
	// Tolerate leading blank lines (the corruption splitNote repairs): the note
	// is still this element's, and rewriting it in place is what heals it.
	const fmId = parseRawFrontmatterScalars(content.replace(/^\s+/, ""), ["id"]).id;
	if (fmId) return fmId;
	// An old span note's id, only from a note in the old layout: a quoted example never makes a note an element's.
	return oldSpanNoteId(content);
}

/**
 * The note a pull writes to when several notes hold one element's id: the one
 * in the element's own type folder under Elements/, else the first by path. The
 * pull's plan and the writer both choose by this, so they never pick two.
 */
export function pickNoteForId(paths: string[], worldName: string, type: string): string | null {
	if (paths.length === 0) return null;
	const elements = `OnlyWorlds/Worlds/${worldName}/Elements`;
	const sorted = [...paths].sort();
	return sorted.find((p) => isInCategoryFolder(p, elements, type)) ?? sorted[0];
}

/**
 * A note's front matter: the metadata cache's, else the note's own YAML read
 * from disk (the cache is cold at start-up and for a note written a moment
 * ago, and a scan that trusted it would silently leave such a note out).
 */
export async function readFrontmatter(app: App, file: TFile): Promise<Record<string, unknown> | undefined> {
	const entry = app.metadataCache.getFileCache(file);
	// A note Obsidian has indexed is trusted, a note with no front matter included (no read of every plain note, every time).
	if (entry) return entry.frontmatter as Record<string, unknown> | undefined;
	try {
		return parseRawFrontmatter(await app.vault.read(file)) ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * A world's element notes, wherever they sit in its folder, each with its type
 * (the Markdown profile, sentences 1 and 2), by `elementNoteType`: the first
 * type folder on its path decides, and only a note outside every type folder is
 * read by its `type` property, with an id that is a UUID. Every other note is
 * the person's own and is not listed. A note in a type folder under Elements/
 * needs no front matter to be read (an old span note has none); any other is
 * read from the metadata cache, or from the disk when the cache is cold. One
 * pass over the vault. `category` is the type's folder spelling (`Location`).
 */
export async function worldElementNotes(app: App, worldName: string): Promise<Array<{ file: TFile; category: string }>> {
	const out: Array<{ file: TFile; category: string }> = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!mayBeElementNote(file.path, worldName)) continue;
		const fm = isUnderElements(file.path) && typeOfPlace(file.path) ? undefined : await readFrontmatter(app, file);
		const found = elementNoteType(file.path, fm);
		if (found) out.push({ file, category: found.category });
	}
	return out;
}

/**
 * A world's element notes as Copy and Upload read them: each candidate note's
 * bytes read once, and everything decided from that one reading, never the
 * metadata cache. Its type is `elementNoteType` of its front matter as the
 * bytes hold it (place decides, else the `type` property with a UUID id), as
 * `readElement` reads it from the same bytes. An old span note has no front
 * matter, so it is listed only where its place gives the type. Returns each
 * note with its type (the folder spelling), the content read, for every
 * read after (no second read of a note in the run), and its front matter's
 * string id as `readElement` reads it from those bytes (null for a note with
 * none, an old span note included: each command counts an old span note by the
 * id its own parser emits). A candidate whose read fails (a file deleted
 * mid-run, a sync placeholder) is returned in `unreadable`: Copy and Upload
 * then stop and name it (unreadableStopMessage), copying and sending nothing.
 */
export async function worldElementNotesFromBytes(app: App, worldName: string): Promise<{
	notes: Array<{ file: TFile; category: string; content: string; id: string | null }>;
	unreadable: TFile[];
}> {
	const notes: Array<{ file: TFile; category: string; content: string; id: string | null }> = [];
	const unreadable: TFile[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!mayBeElementNote(file.path, worldName)) continue;
		let content: string;
		try {
			content = await app.vault.read(file);
		} catch {
			unreadable.push(file);
			continue;
		}
		const fm = parseRawFrontmatter(content) ?? undefined;
		const found = elementNoteType(file.path, fm);
		if (!found) continue;
		notes.push({ file, category: found.category, content, id: typeof fm?.id === "string" ? fm.id : null });
	}
	return { notes, unreadable };
}

/**
 * What Copy and Upload say when a note in the world's folder could not be
 * read: the run stops, since a note nobody read may hold another note's id.
 * Named by its path in the vault (two notes may share a name); more than one:
 * the first, and how many more. `nothing` is what did not happen ("nothing
 * was copied").
 */
export function unreadableStopMessage(unreadable: TFile[], nothing: string): string {
	const more = unreadable.length - 1;
	const others = more > 0 ? ` and ${more} more note${more === 1 ? "" : "s"}` : "";
	return `${unreadable[0].path}${others} could not be read, so ${nothing}. Try again.`;
}

/**
 * The key a duplicate count gives an id a command emits: the id as text, or
 * null when it has none. An old span parser can emit a link's id list, which
 * counts as its text joined by commas, as the count over the emitted elements
 * always did (String of a list).
 */
export function emittedIdKey(id: unknown): string | null {
	if (!id) return null;
	if (typeof id === "string") return id;
	if (typeof id === "number") return String(id);
	if (Array.isArray(id)) return id.map((v) => emittedIdKey(v) ?? "").join(",");
	return null;
}

/**
 * The ids two or more of these notes hold: counted over every note a command
 * listed, before any note is refused for anything else, so a refused note
 * never makes its twin look unique.
 */
export function duplicateIds(ids: Array<string | null>): Set<string> {
	const seen = new Set<string>();
	const twice = new Set<string>();
	for (const id of ids) {
		if (!id) continue;
		if (seen.has(id)) twice.add(id);
		seen.add(id);
	}
	return twice;
}

/** The id in a note's own front matter, read from its bytes with the same YAML reader the cache's reading stands for (a flow block, a quoted key and a trailing comment included). */
async function frontmatterIdOnDisk(app: App, file: TFile): Promise<string | undefined> {
	try {
		const id = parseRawFrontmatter(await app.vault.read(file))?.id;
		return typeof id === "string" ? id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Find an element note by embedded frontmatter id, wherever it sits in the
 * world's folder (the Markdown profile, sentence 1): a note a person moved out
 * of its type folder, with its id and a `type`, is still the element's and a
 * pull writes to it, not to a second note. Only an element note counts: a note
 * the plugin would not save is the person's own and is never written over.
 */
async function findNoteById(
	app: App,
	worldName: string,
	folderName: string,
	id: string
): Promise<TFile | null> {
	const found = new Map<string, TFile>();
	for (const f of app.vault.getMarkdownFiles()) {
		if (!mayBeElementNote(f.path, worldName)) continue;
		const entry = app.metadataCache.getFileCache(f);
		if (entry && entry.frontmatter?.id !== id) continue;
		const fm = entry ? entry.frontmatter : await readFrontmatter(app, f);
		if (!fm || fm.id !== id || !elementNoteType(f.path, fm)) continue;
		found.set(f.path, f);
	}
	// The pick is confirmed from the note's own bytes: the index can still hold
	// an id a person has just taken out of the note, and a writer that trusted
	// it would write the element over what is now the person's own note.
	while (found.size > 0) {
		const path = pickNoteForId([...found.keys()], worldName, folderName);
		const file = path ? found.get(path) : undefined;
		if (!path || !file) return null;
		if ((await frontmatterIdOnDisk(app, file)) === id) return file;
		found.delete(path);
	}
	return null;
}

/**
 * Build a link-name -> id resolver over the vault's notes for a world. Reads
 * frontmatter id (falling back to a span id scrape for unmigrated notes).
 * Used when reading a legacy span note whose links are [[names]].
 */
function buildVaultLinkResolver(app: App, worldName: string): (name: string) => string | null {
	const index = new Map<string, string>();
	const files = app.vault.getMarkdownFiles().filter((f) => mayBeElementNote(f.path, worldName));
	for (const f of files) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm && typeof fm.id === "string" && typeof fm.name === "string") {
			index.set(fm.name, fm.id);
			index.set(f.basename, fm.id);
		}
	}
	return (name: string) => index.get(name) ?? null;
}

/**
 * Build an id -> display-name resolver over a world's element notes (the INVERSE
 * of buildVaultLinkResolver). Used on WRITE to render link ids as `[[Name]]`
 * wikilinks (R1). An id with no local note returns null, so the raw id is kept
 * (dangling/cross-world links never lost).
 */
function buildIdToNameResolver(app: App, worldName: string): (id: string) => string | null {
	const index = new Map<string, string>();
	const files = app.vault.getMarkdownFiles().filter((f) => mayBeElementNote(f.path, worldName));
	for (const f of files) {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm && typeof fm.id === "string") {
			const name = typeof fm.name === "string" && fm.name ? fm.name : f.basename;
			index.set(fm.id, name);
		}
	}
	return (id: string) => index.get(id) ?? null;
}

/**
 * Build the `[[Name]]` -> id resolver for READ (R1), scoped by the link
 * field's TARGET TYPE.
 *
 * ★ A Location and a Collective both named Syracuse are both `Syracuse.md`, in
 * different folders, and download writes plain `[[Syracuse]]`. Obsidian's own
 * resolution picks one of them for every link (live: the Location), so the
 * Collective field got the Location's id. A link field names its target type
 * in the schema, so the name is matched against notes of THAT type only,
 * whatever the type's folder is named or counted ("Location (12)").
 *
 *   - target a type: the note of that type whose basename is the name
 *     (case-insensitive, as Obsidian matches). A path-qualified link, or no
 *     match, falls back to Obsidian's resolution, accepted only if the note it
 *     finds is of the target type.
 *   - target `any` (a Pin's `element_id`): the name across every type; one
 *     match resolves, more than one is AMBIGUOUS_LINK (left out, named), none
 *     falls back to Obsidian's resolution.
 *   - no target (unknown category): Obsidian's resolution, as before.
 *
 * The note's frontmatter `id` is the resolved value; no note or no id yields
 * null (reported unresolved, never guessed). Obsidian's own click on an
 * ambiguous name stays Obsidian's.
 */
export function buildWikilinkResolver(
	app: App,
	sourcePath: string
): (name: string, target?: string) => string | null | typeof AMBIGUOUS_LINK {
	const idOf = (f: TFile): string | null => {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		return fm && typeof fm.id === "string" ? fm.id : null;
	};
	const typeOf = (f: TFile): string | null => {
		const info = elementNoteType(f.path, app.metadataCache.getFileCache(f)?.frontmatter);
		return info ? normalizeCategory(info.category) : null;
	};
	const obsidian = (name: string, target?: string): string | null => {
		const dest = app.metadataCache.getFirstLinkpathDest(name, sourcePath);
		if (!dest) return null;
		if (target && target !== "any" && typeOf(dest) !== target) return null;
		return idOf(dest);
	};
	const worldName = worldNotePath(sourcePath)?.worldName ?? null;
	/** Element notes of this world whose basename is `name`, of the target type, wherever they sit. */
	let byBasename: Map<string, TFile[]> | null = null;
	const notesNamed = (name: string, target: string): TFile[] => {
		if (!worldName) return [];
		// The world's notes by file name, made once per resolver: one pass over the vault, not one per link.
		if (!byBasename) {
			byBasename = new Map();
			for (const f of app.vault.getMarkdownFiles()) {
				if (!mayBeElementNote(f.path, worldName)) continue;
				const key = f.basename.toLowerCase();
				byBasename.set(key, [...(byBasename.get(key) ?? []), f]);
			}
		}
		const out: TFile[] = [];
		for (const f of byBasename.get(name.toLowerCase()) ?? []) {
			const type = typeOf(f);
			if (!type || (target !== "any" && type !== target)) continue;
			out.push(f);
		}
		return out;
	};
	return (name: string, target?: string) => {
		const t = target ? normalizeCategory(target) : undefined;
		if (!t || name.includes("/")) return obsidian(name, t);
		const matches = notesNamed(name.replace(/\.md$/i, ""), t);
		if (t === "any") {
			const types = new Set(matches.map(typeOf));
			if (types.size > 1) return AMBIGUOUS_LINK;
		}
		if (matches.length === 1) return idOf(matches[0]);
		return obsidian(name, t);
	};
}

/** The note past its frontmatter's closing line (trailing spaces after its `---` included: the fix round, item 7). */
function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const close = frontmatterClose(content);
	return close ? content.slice(close.after) : content;
}

function extractFrontmatterBlock(content: string): string {
	if (!content.startsWith("---")) return "";
	const close = frontmatterClose(content);
	return close ? content.slice(0, close.end + 4) : "";
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
