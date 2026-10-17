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
	defaultEmail: string;
	defaultCategory: string;
	individualElementCommands: boolean;

	autoSync: boolean;
	debounceMs: number;
	showStatusBar: boolean;

	/**
	 * v2 change-feed watermarks per world id: enables incremental Download World.
	 * `cursor` resumes the /changes walk; `head` detects server rewinds
	 * (restore-from-backup) — a lower head than stored forces a cold re-walk.
	 */
	syncCursors: Record<string, { cursor: string; head: number }>;

	/**
	 * An OnlyWorlds account token (`ow_a_`), kept like the API key (masked in
	 * the UI), and the username it signed in as. Empty: not signed in, and every
	 * command works as it did before accounts (key and PIN per world).
	 */
	accountToken: string;
	accountUsername: string;

	/**
	 * Download World and Create World write `<world>.base` beside World.md: a
	 * table and a card view per element type in Obsidian's core Bases (OW Infra
	 * #188). A file the user changed is never overwritten.
	 */
	writeBasesFile: boolean;

	/**
	 * World folders whose Bases file Download kept because the user changed it,
	 * and already said so in a Notice: the Notice shows once per world, not on
	 * every Download. A world leaves the list when the plugin owns its file again.
	 */
	basesKeptNoticed: string[];

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
	defaultEmail: "",
	defaultCategory: "Character",
	individualElementCommands: false,

	autoSync: false,
	debounceMs: 3000,
	showStatusBar: true,

	syncCursors: {},

	accountToken: "",
	accountUsername: "",

	writeBasesFile: true,
	basesKeptNoticed: [],
	basesIntroShown: false,
	canvasIncomingLinks: true,
};
