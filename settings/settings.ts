/**
 * Plugin settings persisted in Obsidian's data.json.
 *
 * API key is persisted (masked in the UI). PIN is NEVER persisted —
 * it lives only in plugin memory for the current session (see auth/pin-cache.ts).
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
};
