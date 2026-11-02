import { Notice, TFile } from 'obsidian';
import type OnlyWorldsPlugin from '../main';
import { V2Client } from '../client-v2';
import { elementPathParts } from '../vault/category-folder';
import { resolveWorldKey, splitWorldsByWrite } from '../vault/world-key';
import { openInBrowser } from '../Modals/SignInModal';
import { TextPromptModal } from '../Modals/TextPromptModal';
import {
    LOCAL_HAS_NO_PAGE,
    NOT_AN_ELEMENT,
    WORLD_NOT_TELLABLE,
    keyFitsWorld,
    noNoteFor,
    noteIdOf,
    pickNote,
    readAddress,
    siteAddressOf,
    type AddressedNote,
} from '../account/waymark';

/** A world's id by the key that reads it: one read of the world per key, per session. */
const worldIds = new Map<string, string>();

async function worldIdOf(apiKey: string): Promise<string> {
    const known = worldIds.get(apiKey);
    if (known) return known;
    const meta = await new V2Client(apiKey, '').getWorld();
    const id = String(meta.id ?? '');
    if (!id) throw new Error('The world answered without an id.');
    worldIds.set(apiKey, id);
    return id;
}

/** "Open this note on onlyworlds.com": the active element note's page on the site, from its id and its world's. */
export async function openNoteOnSite(plugin: OnlyWorldsPlugin, file: TFile): Promise<void> {
    const parts = elementPathParts(file.path);
    const id = noteIdOf(plugin.app.metadataCache.getFileCache(file)?.frontmatter);
    if (!parts || !id) {
        new Notice(NOT_AN_ELEMENT, 8000);
        return;
    }
    try {
        const resolved = await resolveWorldKey(plugin.app, parts.worldName, plugin.settings.apiKey);
        if (resolved.source === 'local-world' || !resolved.apiKey) {
            new Notice(LOCAL_HAS_NO_PAGE, 8000);
            return;
        }
        const { writable, readOnly } = await splitWorldsByWrite(plugin.app, plugin.settings.apiKey);
        if (!keyFitsWorld(resolved, writable.length + readOnly.length)) {
            new Notice(WORLD_NOT_TELLABLE, 10000);
            return;
        }
        openInBrowser(siteAddressOf(await worldIdOf(resolved.apiKey), parts.type, id));
    } catch (e) {
        new Notice(e instanceof Error ? e.message : String(e), 10000);
    }
}

/** Every element note of the vault with its id and the type its folder holds. */
function addressedNotes(plugin: OnlyWorldsPlugin): AddressedNote[] {
    const out: AddressedNote[] = [];
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const parts = elementPathParts(file.path);
        if (!parts) continue;
        const id = noteIdOf(plugin.app.metadataCache.getFileCache(file)?.frontmatter);
        if (id) out.push({ path: file.path, type: parts.type, id });
    }
    return out;
}

/** "Open a note from an address": the note that holds the element a pasted address names, found by its id. */
export async function openNoteFromAddress(plugin: OnlyWorldsPlugin, text: string): Promise<void> {
    const read = readAddress(text);
    if (!read.ok) {
        new Notice(read.reason, 8000);
        return;
    }
    const note = pickNote(addressedNotes(plugin), read);
    const file = note ? plugin.app.vault.getAbstractFileByPath(note.path) : null;
    if (!note || !(file instanceof TFile)) {
        new Notice(noNoteFor(read.type), 8000);
        return;
    }
    await plugin.app.workspace.getLeaf(false).openFile(file);
}

export function registerWaymarkCommands(plugin: OnlyWorldsPlugin): void {
    plugin.addCommand({
        id: 'open-note-on-site',
        name: 'Open this note on onlyworlds.com',
        checkCallback: (checking: boolean) => {
            const file = plugin.app.workspace.getActiveFile();
            if (!file || !elementPathParts(file.path)) return false;
            if (!checking) void openNoteOnSite(plugin, file);
            return true;
        },
    });
    plugin.addCommand({
        id: 'open-note-from-address',
        name: 'Open a note from an address',
        callback: () => {
            new TextPromptModal(plugin.app, 'Open a note from an address', 'An OnlyWorlds address', (text) => {
                void openNoteFromAddress(plugin, text);
            }, 'Open').open();
        },
    });
}
