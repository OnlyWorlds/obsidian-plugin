/**
 * World-key resolution — the PURE decision core. No obsidian imports, so the
 * test build can compile it (tsconfig.test.json includes pure modules only).
 * The vault IO wrapper (reading World.md) lives in world-key.ts.
 */

export type KeySource = 'world-file' | 'settings' | 'none' | 'local-world';

/**
 * The World.md token marking a deliberately account-less world ("API Key: local").
 * Distinct from an ABSENT key: absent may fall back to the settings key (legacy
 * single-world vaults), but 'local' is an explicit state and must never fall
 * back — a local world syncing through the settings key would write its
 * elements into whatever world that key names (the wrong-world class, and for
 * RenameWorld it would rename that other world on the server).
 * Cannot collide with real keys: those are ow_-prefixed or 10-digit.
 */
export const LOCAL_WORLD_KEY_TOKEN = 'local';

export interface ResolvedWorldKey {
    apiKey: string | null;
    source: KeySource;
    /** True when the key came from the world's own World.md (unambiguous). */
    ownWorld: boolean;
}

/**
 * Pure decision core of resolveWorldKey.
 * ownKey is the raw World.md key value (or null when the line is absent/empty).
 */
export function classifyWorldKey(
    ownKey: string | null,
    settingsKey: string | undefined,
): ResolvedWorldKey {
    const own = ownKey?.trim();
    if (own && own.toLowerCase() === LOCAL_WORLD_KEY_TOKEN) {
        return { apiKey: null, source: 'local-world', ownWorld: true };
    }
    if (own) {
        return { apiKey: own, source: 'world-file', ownWorld: true };
    }
    const fallback = settingsKey?.trim();
    if (fallback) {
        return { apiKey: fallback, source: 'settings', ownWorld: false };
    }
    return { apiKey: null, source: 'none', ownWorld: false };
}

/** Shared user-facing line for the local-world sync gate — one wording, everywhere. */
export const LOCAL_WORLD_SYNC_MESSAGE =
    'This is a local-only world — nothing was sent to onlyworlds.com. To enable sync, ' +
    'create a world at onlyworlds.com and put its API key in World.md.';
