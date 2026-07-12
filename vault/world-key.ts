import { App, TFile, normalizePath } from 'obsidian';

/**
 * Resolve the API key for a SPECIFIC world folder, safely.
 *
 * The wrong-world write class (2026-07-12): per-world commands used to fall
 * back to the plugin's settings key whenever a world's own key was missing,
 * silently writing to whatever world the settings key named. In a vault holding
 * more than one world, a rename/save/upload under folder B would land in world
 * A. The settings key survives a vault-content clear (it lives in
 * .obsidian/data.json), so "I cleared the vault" did not clear it.
 *
 * The rule now: a per-world write uses the world's OWN World.md key. The
 * settings key is used ONLY when it is the sole candidate (single-world vaults
 * that keep the key in settings, not World.md) — and the caller is told which
 * source won, so it can warn before writing to a possibly-different world.
 */

export type KeySource = 'world-file' | 'settings' | 'none';

export interface ResolvedWorldKey {
    apiKey: string | null;
    source: KeySource;
    /** True when the key came from the world's own World.md (unambiguous). */
    ownWorld: boolean;
}

/** The world's own API key from its World.md, or null. */
export async function worldFileApiKey(app: App, worldName: string): Promise<string | null> {
    const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/World.md`);
    const worldFile = app.vault.getAbstractFileByPath(worldFilePath);
    if (!(worldFile instanceof TFile)) {
        return null;
    }
    const content = await app.vault.read(worldFile);
    // Any non-whitespace token: classic 10-digit OR ow_-prefixed keys.
    const match = content.match(/^- \*\*API Key:\*\* (.+)$/m);
    const key = match?.[1]?.trim();
    return key || null;
}

/**
 * Resolve the key to use for a per-world write. World.md wins; settings is the
 * fallback ONLY when the world carries no key of its own.
 */
export async function resolveWorldKey(
    app: App,
    worldName: string,
    settingsKey: string | undefined,
): Promise<ResolvedWorldKey> {
    const own = await worldFileApiKey(app, worldName);
    if (own) {
        return { apiKey: own, source: 'world-file', ownWorld: true };
    }
    const fallback = settingsKey?.trim();
    if (fallback) {
        return { apiKey: fallback, source: 'settings', ownWorld: false };
    }
    return { apiKey: null, source: 'none', ownWorld: false };
}
