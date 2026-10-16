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
};
