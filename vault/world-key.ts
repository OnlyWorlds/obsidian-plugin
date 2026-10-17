import { App, TFile, TFolder, normalizePath } from 'obsidian';

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

// Pure decision core + shared constants live in world-key-core.ts (obsidian-free,
// so the test build can compile it). Re-exported here so import sites are unchanged.
export {
    classifyWorldKey,
    isReadKey,
    LOCAL_WORLD_KEY_TOKEN,
    LOCAL_WORLD_SYNC_MESSAGE,
    READ_ONLY_WORLD_MESSAGE,
    READ_ONLY_WORLDS_NOT_LISTED,
} from './world-key-core';
export type { KeySource, ResolvedWorldKey } from './world-key-core';
import { classifyWorldKey } from './world-key-core';
import type { ResolvedWorldKey } from './world-key-core';

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
 * Overwrite the API Key value in a world's World.md (e.g. replacing the 'local'
 * token with a freshly-minted server key when a local world goes online).
 * Same-line value replacement only — no lines inserted, so the file's ending
 * convention is untouched. Returns false if World.md or its key line is missing.
 */
export async function writeWorldFileApiKey(app: App, worldName: string, newKey: string): Promise<boolean> {
    const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/World.md`);
    const worldFile = app.vault.getAbstractFileByPath(worldFilePath);
    if (!(worldFile instanceof TFile)) return false;
    const content = await app.vault.read(worldFile);
    const line = /^- \*\*API Key:\*\* .+$/m;
    if (!line.test(content)) return false;
    await app.vault.modify(worldFile, content.replace(line, `- **API Key:** ${newKey}`));
    return true;
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
    return classifyWorldKey(own, settingsKey);
}

/**
 * The vault's worlds (folders under OnlyWorlds/Worlds holding a World.md),
 * split by whether this vault can write to them: a read key (ow_r_) is
 * read-only, every other key or a local world is writable. The one split every
 * world picker that writes uses (Rename World, Upload World), so their lists
 * cannot drift (Kael's cold read, h37 #6484).
 */
export async function splitWorldsByWrite(
    app: App,
    settingsKey: string | undefined,
): Promise<{ writable: string[]; readOnly: string[] }> {
    const writable: string[] = [];
    const readOnly: string[] = [];
    const worlds = app.vault.getAbstractFileByPath(normalizePath('OnlyWorlds/Worlds'));
    if (!(worlds instanceof TFolder)) return { writable, readOnly };
    for (const child of worlds.children) {
        if (!(child instanceof TFolder)) continue;
        if (!child.children.some((f) => f instanceof TFile && f.name === 'World.md')) continue;
        const resolved = await resolveWorldKey(app, child.name, settingsKey);
        (resolved.readOnly ? readOnly : writable).push(child.name);
    }
    return { writable, readOnly };
}
