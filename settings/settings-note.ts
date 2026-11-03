/**
 * The old settings note, retired (OW Obsidian #1117, the Captain's word, 2026-11-03).
 *
 * Until 3.17.0 the plugin created `OnlyWorlds/Settings.md` and read three values out of it: the primary
 * world's name, the Yes/No for individual creation commands and the default new-element category. The
 * settings tab held the same three, saved them, and nothing read them: only the note was acted on.
 * From now on the tab is the only place. This file does the one-time carry-over and nothing else:
 * the note's values move into the tab's settings, then the note says where they went.
 *
 * Pure on purpose (no Obsidian import): the note's text goes in, values come out, so the test build
 * compiles it and the migration is tried against a plain in-memory store.
 */

export const SETTINGS_NOTE_PATH = "OnlyWorlds/Settings.md";

/** What the plugin's own template began with. A note without it is the user's own text and is never rewritten. */
export const NOTE_HEADER = "# OnlyWorlds Plugin Settings";

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

export function isPluginTemplateNote(content: string): boolean {
	return content.trimStart().startsWith(NOTE_HEADER);
}

/** What the note says once its values have moved. Says where they went, in the words of the settings pane. */
export function movedNoteText(): string {
	return `${NOTE_HEADER}

These settings moved to Obsidian's own settings: **Settings → Community plugins → OnlyWorlds Builder → Options**.

This note is no longer read. Changing it does nothing, and it is safe to delete.
`;
}

export interface MigratedSettings {
	defaultWorld: string;
	defaultCategory: string;
	individualElementCommands: boolean;
	settingsNoteMigrated: boolean;
}

/**
 * The note's values laid over the current settings. The note is what has been in effect, so it wins where it
 * says something; a missing or invalid line leaves the setting as it is (a category word that is not one of
 * ours is left out, as the old reader left it out).
 */
export function applyNoteValues(
	current: Pick<MigratedSettings, "defaultWorld" | "defaultCategory" | "individualElementCommands">,
	note: NoteValues,
	validCategories: readonly string[],
): Pick<MigratedSettings, "defaultWorld" | "defaultCategory" | "individualElementCommands"> {
	return {
		defaultWorld: note.primaryWorld ?? current.defaultWorld,
		defaultCategory:
			note.defaultCategory !== null && validCategories.includes(note.defaultCategory) ? note.defaultCategory : current.defaultCategory,
		individualElementCommands: note.individualCommands ?? current.individualElementCommands,
	};
}

/** The few things the migration needs from a vault; the plugin hands in an adapter over `app.vault`. */
export interface NoteStore {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
}

export interface MigrationResult {
	/** The settings to keep; null when nothing changed and nothing needs saving. */
	settings: (Pick<MigratedSettings, "defaultWorld" | "defaultCategory" | "individualElementCommands"> & { settingsNoteMigrated: true }) | null;
	/** What happened, for one notice to the user; null for silence. */
	notice: string | null;
	/** The migration could not read the note: try again next start (nothing is marked done). */
	retry: boolean;
}

/**
 * Carry the old note's values into the settings, once. Marks itself done only when it has read the note (or
 * found none). Rewrites the note to the pointer only when it is the plugin's own template; a note the user
 * made their own is left alone and the notice says so.
 */
export async function migrateSettingsNote(
	store: NoteStore,
	current: Pick<MigratedSettings, "defaultWorld" | "defaultCategory" | "individualElementCommands"> & { settingsNoteMigrated?: boolean },
	validCategories: readonly string[],
): Promise<MigrationResult> {
	if (current.settingsNoteMigrated) return { settings: null, notice: null, retry: false };

	let exists: boolean;
	try {
		exists = await store.exists(SETTINGS_NOTE_PATH);
	} catch {
		return { settings: null, notice: null, retry: true };
	}
	if (!exists) {
		return { settings: { ...current, settingsNoteMigrated: true }, notice: null, retry: false };
	}

	let content: string;
	try {
		content = await store.read(SETTINGS_NOTE_PATH);
	} catch {
		return { settings: null, notice: null, retry: true };
	}

	const merged = applyNoteValues(current, parseSettingsNote(content), validCategories);
	let notice = "OnlyWorlds settings moved to Obsidian's settings (Community plugins, OnlyWorlds Builder). Your old Settings note was carried over.";
	if (isPluginTemplateNote(content)) {
		try {
			await store.write(SETTINGS_NOTE_PATH, movedNoteText());
		} catch {
			notice = "OnlyWorlds settings moved to Obsidian's settings, but the old Settings note could not be updated; it is no longer read.";
		}
	} else {
		notice = "OnlyWorlds settings moved to Obsidian's settings. Your Settings note is your own text, so it was left as it is; it is no longer read.";
	}
	return { settings: { ...merged, settingsNoteMigrated: true }, notice, retry: false };
}
