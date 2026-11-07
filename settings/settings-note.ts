/**
 * The old settings note, retired (Titus's word, 2026-11-03).
 *
 * Until 3.17.0 the plugin created `OnlyWorlds/Settings.md` and read three values out of it: the primary
 * world's name, the Yes/No for individual creation commands and the default new-element category. The
 * settings tab held the same three, saved them, and nothing read them: only the note was acted on.
 * From now on the tab is the only place. This file does the one-time carry-over and nothing else:
 * the note's values move into the tab's settings, then the note says where they went.
 *
 * Nothing the user wrote is lost: the plugin's own note is rewritten as a pointer WITH the old text kept
 * beneath it (a cold read of this change found the first version replaced a whole note even when the user
 * had added to it, and that another device, not yet updated or not yet synced, would then find no values).
 * A note that is the user's own text is read and never touched.
 *
 * Pure on purpose (no Obsidian import): the note's text goes in, values come out, so the test build
 * compiles it and the migration is tried against a plain in-memory store.
 */

export const SETTINGS_NOTE_PATH = "OnlyWorlds/Settings.md";

/** What the plugin's own template began with. A note without it is the user's own text and is never rewritten. */
export const NOTE_HEADER = "# OnlyWorlds Plugin Settings";

/** The sentence that marks a note already moved: a second pass leaves it as it is. */
export const MOVED_MARK = "These settings moved to Obsidian's own settings";

export interface NoteValues {
	/** The note's "Primary World Name", trimmed; null when the line is absent or empty. */
	primaryWorld: string | null;
	/** The note's Yes/No; null when the line is absent. */
	individualCommands: boolean | null;
	/** The note's category word; null when the line is absent or empty (validity is judged by the caller). */
	defaultCategory: string | null;
}

/** The three lines the old code read, by the same patterns it used. */
export function parseSettingsNote(content: string): NoteValues {
	const world = content.match(/^- \*\*Primary World Name:\*\*[ \t]*(.*)$/m);
	const ind = content.match(/^- \*\*Individual Element Creation Commands:\*\*[ \t]*(\w+)/m);
	const cat = content.match(/^- \*\*Default New Element Category:\*\*[ \t]*(.*)$/m);
	return {
		primaryWorld: world && world[1].trim() ? world[1].trim() : null,
		individualCommands: ind ? ind[1].toLowerCase() === "yes" : null,
		defaultCategory: cat && cat[1].trim() ? cat[1].trim() : null,
	};
}

/** Whether the note says anything the old code would have acted on. */
export function holdsValues(v: NoteValues): boolean {
	return v.primaryWorld !== null || v.individualCommands !== null || v.defaultCategory !== null;
}

export function isPluginTemplateNote(content: string): boolean {
	return content.trimStart().startsWith(NOTE_HEADER);
}

export function isMovedNote(content: string): boolean {
	return content.includes(MOVED_MARK);
}

/**
 * What the note says once its values have moved: where they went, then the old text unchanged. The old text keeps
 * its value lines on purpose: a device still on an older version, or one the note reaches before the plugin's own
 * settings do, finds its values there. This version never reads the note again once it has moved.
 */
export function movedNoteText(original: string): string {
	return `${NOTE_HEADER}

${MOVED_MARK}: **Settings → Community plugins → OnlyWorlds Builder → Options**.

This note is no longer read by the plugin. Changing it does nothing, and it is safe to delete.

---

The note as it was when the settings moved (kept so nothing you wrote is lost):

${original.trim()}
`;
}

export interface SettingsValues {
	defaultWorld: string;
	defaultCategory: string;
	individualElementCommands: boolean;
}

/**
 * The note's values laid over the current settings, as what was IN EFFECT. In 3.17.0 the note alone acted: an
 * empty world line meant the top folder, a missing Yes/No meant No. So where a note exists the world and the
 * Yes/No take the note's reading, absent or empty included; a pane value typed long ago and never acted on does not
 * quietly take over. A category word that is not one of ours is left out, as the old reader left it out.
 */
export function applyNoteValues(current: SettingsValues, note: NoteValues, validCategories: readonly string[]): SettingsValues {
	return {
		defaultWorld: note.primaryWorld ?? "",
		defaultCategory:
			note.defaultCategory !== null && validCategories.includes(note.defaultCategory) ? note.defaultCategory : current.defaultCategory,
		individualElementCommands: note.individualCommands ?? false,
	};
}

/** The few things the migration needs from a vault; the plugin hands in an adapter over `app.vault`. */
export interface NoteStore {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
}

export interface MigrationResult {
	/** The settings to keep and mark done; null when nothing changed and nothing needs saving. */
	settings: (SettingsValues & { settingsNoteMigrated: true }) | null;
	/** What happened, for one notice to the user; null for silence. */
	notice: string | null;
}

/**
 * Carry the old note's values into the settings, once. Marks itself done only when it has READ a note: no note
 * means nothing is marked, so a note that reaches this device later (a sync that had not delivered it yet) is
 * still carried over; one existence check at each start is the whole cost. A note that is already the pointer is
 * read for the values kept beneath it and not rewritten. A note that is the user's own text is read and left alone.
 * An unreadable note changes nothing and is tried again next start.
 */
export async function migrateSettingsNote(
	store: NoteStore,
	current: SettingsValues & { settingsNoteMigrated?: boolean },
	validCategories: readonly string[],
): Promise<MigrationResult> {
	if (current.settingsNoteMigrated) return { settings: null, notice: null };

	let content: string;
	try {
		if (!(await store.exists(SETTINGS_NOTE_PATH))) return { settings: null, notice: null };
		content = await store.read(SETTINGS_NOTE_PATH);
	} catch {
		return { settings: null, notice: null };
	}

	const values = parseSettingsNote(content);
	const merged = applyNoteValues(current, values, validCategories);
	const done = { ...merged, settingsNoteMigrated: true as const };
	if (!holdsValues(values)) return { settings: done, notice: null };

	let notice = "OnlyWorlds settings moved to Obsidian's settings (Community plugins, OnlyWorlds Builder). Your old Settings note was carried over.";
	if (isMovedNote(content)) {
		// already a pointer (another device moved it): its kept text gave the values; nothing to rewrite
	} else if (isPluginTemplateNote(content)) {
		try {
			await store.write(SETTINGS_NOTE_PATH, movedNoteText(content));
		} catch {
			notice = "OnlyWorlds settings moved to Obsidian's settings, but the old Settings note could not be updated; it is no longer read.";
		}
	} else {
		notice = "OnlyWorlds settings moved to Obsidian's settings. Your Settings note is your own text, so it was left as it is; it is no longer read.";
	}
	return { settings: done, notice };
}
