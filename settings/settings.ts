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
	 * After a save that changed an element's name, rename its note to that name
	 * (Seethe's finding 4, h37 #6503). On by default.
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
	 * them as link targets (OW Infra #166 row 8; Kael's cold read, blocker 1c).
	 */
	deletedOnServer: Record<string, string[]>;

	/**
	 * An OnlyWorlds account token (`ow_a_`), kept like the API key (masked in
	 * the UI), and the username it signed in as. Empty: not signed in, and every
	 * command works as it did before accounts (key and PIN per world).
	 */
	accountToken: string;
	accountUsername: string;
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
	renameNoteOnNameChange: true,

	syncCursors: {},
	deletedOnServer: {},

	accountToken: "",
	accountUsername: "",
};
