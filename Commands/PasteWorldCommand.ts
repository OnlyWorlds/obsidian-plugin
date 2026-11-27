import Handlebars from 'handlebars';
import { WorldPasteModal } from 'Modals/WorldPasteModal';
import { App, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { WorldService, sanitizeFileName } from 'Scripts/WorldService';
import { LOCAL_WORLD_KEY_TOKEN, classifyWorldKey } from '../vault/world-key';
import { Category } from '../enums';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';
import { flushOpenEditors, pickNoteForId, worldNoteIds, writeElementNote, type WrittenNote } from '../vault/element-file';
import { KeptCopies, stoppedMessage } from '../vault/kept-copy';
import { copiedMessage, leftAsTypedMessage } from '../vault/note-mark-core';
import { isHiddenId, isStubNote, type HiddenListHost } from '../sync/hidden-on-server';
import { knownOfKeptText, knownOfWrite, noteStateOf } from '../sync/known-of';

export class PasteWorldCommand {
    app: App;
    manifest: any;
    private worldService: WorldService;

    /** The plugin's settings, for the hidden lists; absent, only stubs are known. */
    private host: HiddenListHost | null;

    /** Auto-sync's self-write guard: each element note this writes is the plugin's own, never an edit to save. */
    private markSelfWrite: ((path: string) => void) | null;

    constructor(app: App, manifest: any, host?: HiddenListHost, markSelfWrite?: (path: string) => void) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = new WorldService(app);
        this.host = host ?? null;
        this.markSelfWrite = markSelfWrite ?? null;
    }

    async execute() {
        let modal = new WorldPasteModal(this.app, async (worldDataJson) => {
            const worldData = worldDataJson['World'];
            const apiKey = worldData ? worldData.api_key : null;
            const worldName = worldData ? worldData.name : null;

            if (!apiKey || !worldName) {
                new Notice('No valid world data found (missing API key or name).');
                return;
            }

            // Find existing world by API key or generate unique world name
            const existingWorldName = await this.findWorldByApiKey(apiKey);
            const targetWorldName = existingWorldName || await this.worldService.generateUniqueWorldName(worldName, apiKey);
         //   console.log(`[PasteWorldCommand] Original world name: ${worldName}, Target name: ${targetWorldName}`);

            const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${targetWorldName}`);
            const elementsFolderPath = normalizePath(`${worldFolderPath}/Elements`);
            const fs = this.app.vault.adapter;

            // Ensure the World and Elements folders exist
            await this.createFolderIfNeeded(worldFolderPath);
            await this.createFolderIfNeeded(elementsFolderPath);

            // Generate world file
            const worldFilePath = `${worldFolderPath}/World.md`;
            if (!await fs.exists(worldFilePath)) {
                await this.generateWorldFile(worldData, worldFolderPath);
            }

            // Readme + Settings notes.
            const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest, { localOnly: classifyWorldKey(apiKey, undefined).source === 'local-world' });
            await createCoreFilesCommand.execute();

            // Generate element notes in the correct category folders under Elements
            const pasted = await this.generateElementNotes(elementsFolderPath, worldDataJson, false);
            if (pasted.stopped) {
                new Notice(pasted.stopped, 20000);
                return;
            }

            if (existingWorldName) {
                new Notice(`Updated existing world: ${targetWorldName}`);
            } else {
                new Notice(`Created new world: ${targetWorldName}`);
            }
        });
        modal.open();
    }

    async createFolderIfNeeded(folderPath: string) {
        const normalizedPath = normalizePath(folderPath);
        let existingFolder = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!existingFolder) {
            try {
                await this.app.vault.createFolder(normalizedPath);
            } catch (error) {
                console.error(`Error creating folder: ${normalizedPath}`, error);
            }
        }
    }

    async generateWorldFile(worldData: any, worldFolderPath: string) {
        const fs = this.app.vault.adapter;
        
        // Add image_display field based on image_url
        if (worldData.image_url) {
            worldData.image_display = `![World Image](${worldData.image_url})`;
        } else {
            worldData.image_display = "None";
        }
        
        // noEscape: span-tag note bodies carry plain data, not HTML — see
        // DownloadWorldCommand. Prevents apostrophes/ampersands escaping on disk.
        const worldTemplate = Handlebars.compile(worldTemplateString, { noEscape: true });
        const worldContent = worldTemplate(worldData);
        const worldFilePath = `${worldFolderPath}/World.md`;
        await fs.write(worldFilePath, worldContent); 
    }

    /**
     * Write the pasted elements' notes. A note it is about to replace and cannot prove unchanged since the plugin last wrote or
     * saved it is copied whole into Kept edits/ first, as Download does (vault/kept-copy.ts). It records no mark: a mark says
     * the world holds a note's bytes, and a pasted note was never sent, so the next pull copies it before it replaces it. Returns the labels of the notes copied, of the notes left as the person has
     * them (each changed under every try of its write), and the notice of a note it could not write (its copy, or the write
     * itself), which stopped it there.
     */
    async generateElementNotes(worldFolderPath: string, data: any, overwrite: boolean): Promise<{ copied: string[]; left: string[]; stopped: string | null }> {
        // Extract the world name from the elements folder path.
        const pathParts = worldFolderPath.split('/');
        const worldsIndex = pathParts.findIndex(part => part === 'Worlds');
        const worldName = worldsIndex >= 0 && pathParts.length > worldsIndex + 1
            ? pathParts[worldsIndex + 1]
            : pathParts[pathParts.length - 1];

        // Build the id -> name map from the pasted payload (every element's id +
        // name), so link fields render as [[Name]] wikilinks. Sanitized to match
        // the on-disk basename writeElement produces (same rule as download).
        const idToName = this.buildIdToNameMap(data);
        const idToRealName = this.buildIdToRealNameMap(data);

        const copies = await KeptCopies.open(this.app, worldName, (p) => this.markSelfWrite?.(p));
        // Each element's note wherever it sits in the world, found as Download finds it.
        const worldIds = await worldNoteIds(this.app, worldName);
        const left: string[] = [];
        let stopped: { label: string; error: unknown } | null = null;
        try {
            notes: for (const category in Category) {
                if (!isNaN(Number(category)) || !Array.isArray(data[category])) continue;

                const elements = data[category];
                // The type's folders, plain first (an older vault may hold a counted
                // one too): a new note goes in the first, a note
                // this element has is found in any of them and written where it is.
                const typeFolders = await this.worldService.findCategoryFolders(worldName, category);
                const categoryDirectory = typeFolders.length > 0
                    ? typeFolders[0].path
                    : normalizePath(`${worldFolderPath}/${category}`);
                if (typeFolders.length === 0) await this.createFolderIfNeeded(categoryDirectory);

                for (const element of elements) {
                    if (!element || typeof element.id !== 'string') continue;
                    // Hidden by the world's owner: an id on a
                    // hidden list is never written, and a stub never overwritten
                    // by an old copy of the element.
                    if (this.host && isHiddenId(this.host.settings, element.id)) continue;

                    // Reuse the note this id has anywhere in the world, else mint a unique filename.
                    const existingElementPath = pickNoteForId(worldIds.get(element.id) ?? [], worldName, category);
                    // An open editor's unsaved text first, so the note is read as the person has it.
                    const found = existingElementPath ? this.app.vault.getAbstractFileByPath(existingElementPath) : null;
                    if (found instanceof TFile) await flushOpenEditors(this.app, found, (p) => this.markSelfWrite?.(p));
                    if (existingElementPath && (await this.isStub(existingElementPath))) continue;
                    // A known-of stub (the folder spec §4.4) is
                    // written as one, never over a whole note (no reset brought it:
                    // the whole copy is kept); the person's writing a known-of note
                    // holds stays above its fields.
                    const existing = existingElementPath ? this.app.vault.getAbstractFileByPath(existingElementPath) : null;
                    const current = existing instanceof TFile ? await this.app.vault.read(existing) : null;
                    const write = knownOfWrite(element, noteStateOf(current), null);
                    if (write === 'keep') continue;
                    const keepAbove = current === null ? '' : knownOfKeptText(current);
                    const fileName = existingElementPath
                        ? existingElementPath.split('/').pop()
                        : await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id);

                    // Same frontmatter writer as Download (Phase B). writeElement owns
                    // placement (re-finds by embedded id), preserves extension fields,
                    // renders link ids as [[Name]] wikilinks, maps body to
                    // description/story. No Handlebars templates, no span format.
                    // Marked before each write as Download marks it, so auto-sync
                    // does not take the pasted content for an edit and save it.
                    const label = `${category} "${element.name ?? element.id}"`;
                    const copy = copies.forNote(element.id, String(element.name ?? element.id), label);
                    let wrote: WrittenNote;
                    try {
                        wrote = await writeElementNote(
                            this.app,
                            worldName,
                            category,
                            element.id,
                            element,
                            {
                                folderPath: existingElementPath ? existingElementPath.slice(0, existingElementPath.lastIndexOf('/')) : categoryDirectory,
                                fileName, idToName, idToRealName, keepAbove, knownOf: write === 'stub',
                                markSelfWrite: (p) => this.markSelfWrite?.(p),
                                // The note found above, so the writer makes no second search.
                                existingPath: existingElementPath,
                                beforeReplace: copy.beforeReplace,
                            }
                        );
                    } catch (error) {
                        // A note it could not write (its copy, or the write itself) stops the paste there, the note not
                        // changed, and the person is told: the dialog's callback is not awaited, so a throw would be heard by no one.
                        stopped = { label, error };
                        break notes;
                    }
                    if (wrote.text === null) { left.push(label); continue; }
                    copy.landed();
                }
            }
        } finally {
            if (copies.copied.length > 0) new Notice(copiedMessage(copies.copied, 'Paste world'), 20000);
            if (left.length > 0) new Notice(leftAsTypedMessage(left, 'Paste world'), 20000);
        }
        return { copied: copies.copied, left, stopped: stopped ? stoppedMessage(stopped.label, stopped.error, 'Paste world') : null };
    }

    /** True when the note at `path` is a hidden element's stub. */
    private async isStub(path: string): Promise<boolean> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        try {
            return isStubNote(await this.app.vault.read(file));
        } catch {
            return false;
        }
    }

    /** id -> sanitized display name over every element in the pasted payload. */
    private buildIdToNameMap(data: any): (id: string) => string | null {
        const map = new Map<string, string>();
        for (const category in Category) {
            if (!Array.isArray(data[category])) continue;
            for (const element of data[category]) {
                if (element && typeof element.id === 'string' && typeof element.name === 'string' && element.name) {
                    map.set(element.id, sanitizeFileName(element.name));
                }
            }
        }
        return (id: string) => map.get(id) ?? null;
    }

    /** id -> the element's own name, for the `### Depends on` lines (shown where it differs from the note's name). */
    private buildIdToRealNameMap(data: any): (id: string) => string | null {
        const map = new Map<string, string>();
        for (const category in Category) {
            if (!Array.isArray(data[category])) continue;
            for (const element of data[category]) {
                if (element && typeof element.id === 'string' && typeof element.name === 'string' && element.name) {
                    map.set(element.id, element.name);
                }
            }
        }
        return (id: string) => map.get(id) ?? null;
    }

    async findWorldByApiKey(apiKey: string): Promise<string | null> {
        // The 'local' token marks EVERY local-only world — it is a state, not an
        // identity. Matching on it would let a pasted local world overwrite a
        // DIFFERENT local world (the wrong-world class, vault edition). Local
        // pastes always land as a new (uniquely-named) world instead.
        if (apiKey.trim().toLowerCase() === LOCAL_WORLD_KEY_TOKEN) {
            return null;
        }
        const worldsPath = normalizePath('OnlyWorlds/Worlds');
        const worldsFolder = this.app.vault.getAbstractFileByPath(worldsPath);
        
        if (!(worldsFolder instanceof TFolder)) {
            return null;
        }

        for (const child of worldsFolder.children) {
            if (child instanceof TFolder) {
                const worldFilePath = normalizePath(`${child.path}/World.md`);
                const worldFile = this.app.vault.getAbstractFileByPath(worldFilePath);
                
                if (worldFile instanceof TFile) {
                    try {
                        const content = await this.app.vault.read(worldFile);
                        const apiKeyMatch = content.match(/^- \*\*API Key:\*\* (.+)$/m);
                        
                        if (apiKeyMatch && apiKeyMatch[1].trim() === apiKey) {
                            return child.name;
                        }
                    } catch (error) {
                        console.error(`Error reading world file: ${worldFilePath}`, error);
                    }
                }
            }
        }
        
        return null;
    }
}
