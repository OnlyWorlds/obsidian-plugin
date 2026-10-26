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
    /**
     * True when the key is a read key (`ow_r_`): it reads without a PIN and can
     * never write. Every write path refuses it BEFORE asking for a PIN, and
     * auto-sync skips the world silently (Kael's review 3.1).
     */
    readOnly: boolean;
}

/** A read-capability key: `ow_r_` (a player link, a guest, a member with no PIN). */
export function isReadKey(key: string | null | undefined): boolean {
    return typeof key === 'string' && key.trim().startsWith('ow_r_');
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
        return { apiKey: null, source: 'local-world', ownWorld: true, readOnly: false };
    }
    if (own) {
        return { apiKey: own, source: 'world-file', ownWorld: true, readOnly: isReadKey(own) };
    }
    const fallback = settingsKey?.trim();
    if (fallback) {
        return { apiKey: fallback, source: 'settings', ownWorld: false, readOnly: isReadKey(fallback) };
    }
    return { apiKey: null, source: 'none', ownWorld: false, readOnly: false };
}

/** The one line every write path shows for a read key. */
export const READ_ONLY_WORLD_MESSAGE =
    'This world is read-only in this vault: its key (ow_r_) can read but not write, ' +
    'so nothing was sent to onlyworlds.com. Your edits stay in your notes. ' +
    'To write, download the world again with an account that can write.';

/** The line a world picker that writes shows when it left read-only worlds out (Kael's cold read, 2026-10-17). */
export const READ_ONLY_WORLDS_NOT_LISTED =
    'Read-only worlds are not listed: their key can read but not write.';

/** Shared user-facing line for the local-world sync gate — one wording, everywhere. */
/**
 * ⚑ Point at the flow, not at the homework. The plugin already has a one-move
 * take-online path (Create World → "take an existing local world online"): it
 * creates the server world, writes the key into World.md and uploads the
 * elements. Telling the user to go make a world and paste a key by hand sent
 * them down the long road past a door that was already there (2026-08-22).
 */
export const LOCAL_WORLD_SYNC_MESSAGE =
    'This is a local-only world — nothing was sent to onlyworlds.com. ' +
    'To put it online: run "Create world" and use "Or take a local world online" — ' +
    'it creates the world, links the key and uploads everything in one move. ' +
    '(Or paste an existing world\'s API key into World.md yourself.)';
