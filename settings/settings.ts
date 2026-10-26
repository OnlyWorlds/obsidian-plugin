/**
 * Plugin settings persisted in Obsidian's data.json.
 *
 * The API key is persisted (masked in the UI). The PIN is persisted only when the user
 * types one in the settings tab; left empty, it is asked once per session and held in
 * memory (see auth/pin-cache.ts, which tries the persisted PIN first).
 */
export interface OnlyWorldsPluginSettings {
	apiKey: string;
	apiPin: string;
	defaultWorld: string;
	// `defaultEmail` went with the email-and-PIN create (3.11);
	// an older data.json that still holds it loads as before (the key
	// is carried along by loadSettings' Object.assign and read by nothing).
	defaultCategory: string;
	individualElementCommands: boolean;

	autoSync: boolean;
	debounceMs: number;
	showStatusBar: boolean;
	/**
	 * After Save Element changed an element's name, rename its note to that name
	 * (Seethe's finding 4, 2026-10-17). On by default.
	 */
	renameNoteOnNameChange: boolean;

	/**
	 * v2 change-feed watermarks per world id: enables incremental Download World.
	 * `cursor` resumes the /changes walk; `head` detects server rewinds
	 * (restore-from-backup) — a lower head than stored forces a cold re-walk.
	 */
	syncCursors: Record<string, { cursor: string; head: number }>;

	/**
	 * Per world id: element ids the change feed reported deleted on the server,
	 * kept by Download (whose notes stay, on purpose). A save never recreates
	 * them as link targets (Kael's cold read, blocker 1c).
	 */
	deletedOnServer: Record<string, string[]>;

	/**
	 * Per world id: element ids the world's owner hid from this reader (a feed
	 * delete row with reason `hidden`, or a 409 with reason `view` whose walk no
	 * longer names them). Download keeps each note as a stub; a save or an
	 * upload never sends the id (sync/hidden-on-server.ts).
	 */
	hiddenOnServer: Record<string, string[]>;

	/**
	 * Per world id: the element ids Download's walks found on the server, so a
	 * 409 with reason `view` stubs only notes whose element was there, never a
	 * note made here and not yet saved.
	 */
	knownOnServer: Record<string, string[]>;

	/**
	 * Per world id: element ids a role (or no-reason) reset's walk no longer
	 * named. Their notes are kept, the person's now: keel answers the id 404, and
	 * a save or an upload never creates it again. An upsert of the id later
	 * takes it off (Kael's read, 2026-10-20).
	 */
	leftView: Record<string, string[]>;
	/**
	 * Per world id: whole notes kept as last known when their element arrived
	 * as a known-of stub after a role reset, or with none (the folder spec §4.4
	 * rule 5). keel now serves a stub for them, so a save or an upload never
	 * sends them; the id leaves the list when the element arrives whole or the
	 * note becomes a stub.
	 */
	lastKnown: Record<string, string[]>;

	/**
	 * An OnlyWorlds account token (`ow_a_`), kept like the API key (masked in
	 * the UI), and the username it signed in as. Empty: not signed in, and every
	 * command works as it did before accounts (key and PIN per world).
	 */
	accountToken: string;
	accountUsername: string;

	/**
	 * Download World and Create World write `<world>.base` beside World.md: a
	 * table and a card view per element type in Obsidian's core Bases.
	 * A file the user changed is never overwritten.
	 */
	writeBasesFile: boolean;

	/**
	 * World folders whose Bases file Download kept because the user changed it,
	 * and already said so in a Notice: the Notice shows once per world, not on
	 * every Download. A world leaves the list when the plugin owns its file again.
	 */
	basesKeptNoticed: string[];

	/**
	 * Per world folder, the ids of element notes whose new name auto-sync saved
	 * without renaming the note: the next Save Element renames it, after a
	 * restart too.
	 */
	pendingRenames: Record<string, string[]>;

	/**
	 * Download has said, once for this vault, that it now writes a Bases file
	 * (the first time it wrote one into a world folder that had none).
	 */
	basesIntroShown: boolean;

	/**
	 * Draw relationships on a canvas also draws the elements that link TO the
	 * element (found by reading the world's notes once), not only those it links to.
	 */
	canvasIncomingLinks: boolean;
}

export const DEFAULT_SETTINGS: OnlyWorldsPluginSettings = {
	apiKey: "",
	apiPin: "",
	defaultWorld: "",
	defaultCategory: "Character",
	individualElementCommands: false,

	autoSync: false,
	debounceMs: 3000,
	showStatusBar: true,
	renameNoteOnNameChange: true,

	syncCursors: {},
	deletedOnServer: {},
	hiddenOnServer: {},
	knownOnServer: {},
	leftView: {},
	lastKnown: {},

	accountToken: "",
	accountUsername: "",

	writeBasesFile: true,
	basesKeptNoticed: [],
	pendingRenames: {},
	basesIntroShown: false,
	canvasIncomingLinks: true,
};
