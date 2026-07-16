import Handlebars from 'handlebars';
import { WorldDownloadData, WorldDownloadModal } from 'Modals/WorldDownloadModal';
import { App, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { WorldService, sanitizeFileName } from 'Scripts/WorldService';
import { Category } from '../enums';
import { V2ApiError, V2Change, V2Client } from '../client-v2';
import type OnlyWorldsPlugin from '../main';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';
import { writeElement } from '../vault/element-file';
import { parseRawFrontmatterScalars } from '../vault/element-transform';

export class DownloadWorldCommand {
    app: App;
    manifest: any;
    private worldService: WorldService;
    private plugin: OnlyWorldsPlugin | null;

    constructor(app: App, manifest: any, plugin?: OnlyWorldsPlugin) {
        this.app = app;
        this.manifest = manifest;
        this.plugin = plugin ?? null;
        this.worldService = new WorldService(app);
    }

    async execute(overwrite: boolean = false) {
        new WorldDownloadModal(this.app, async (data: WorldDownloadData | null) => {
            if (!data) {
                // User cancelled the operation
                return;
            }

            if (data.apiKey.trim().length > 0) {
                try {
                    new Notice('Downloading world...');
                    const client = new V2Client(data.apiKey.trim(), String(data.pin));

                    // World meta first — also validates the credential pair with a
                    // precise error before any element traffic.
                    const worldMeta = await client.getWorld();
                    const worldId = String(worldMeta.id ?? '');
                    const worldName = worldMeta.name ? String(worldMeta.name) : null;

                    if (!worldName) {
                        new Notice('No valid world data found.');
                        return;
                    }

                    // Incremental pull when we hold a cursor for this world; a
                    // server rewind (head below our stored head) or a rejected
                    // cursor forces a cold re-walk from the epoch.
                    //
                    // Watermark vs vault reality (Captain's smoke, 2026-07-16):
                    // settings/data.json OUTLIVES vault content — after clearing
                    // the world folder, a stored cursor at head means "changes
                    // since" = zero, and Download honestly writes NOTHING into an
                    // empty vault. If the vault holds no element notes for this
                    // world, the cursor is stale state, not truth: ignore it and
                    // pull cold.
                    let stored = this.plugin?.settings.syncCursors?.[worldId];
                    if (stored && !this.vaultHasElementNotes(worldName)) {
                        console.log('OnlyWorlds: vault has no notes for this world — ignoring sync cursor, full download.');
                        stored = undefined;
                    }
                    let walk: { changes: V2Change[]; cursor: string | null; head: number };
                    try {
                        walk = await client.changesWalk(stored?.cursor);
                        if (stored && walk.head < stored.head) {
                            walk = await client.changesWalk();
                        }
                    } catch (e) {
                        if (stored) {
                            walk = await client.changesWalk();
                        } else {
                            throw e;
                        }
                    }

                    // Fold the change stream into per-category buckets. Changes
                    // arrive in sequence order, so later ops win per element id.
                    const latest = new Map<string, V2Change>();
                    for (const change of walk.changes) {
                        latest.set(change.id, change);
                    }
                    const worldData: Record<string, any> = {};
                    let deleteCount = 0;
                    for (const change of latest.values()) {
                        if (change.op === 'delete') {
                            // Notes are never auto-deleted (a note may hold user
                            // prose beyond the element). Surface the count instead.
                            deleteCount++;
                            continue;
                        }
                        if (!change.element) continue;
                        const category = change.type.charAt(0).toUpperCase() + change.type.slice(1);
                        (worldData[category] ??= []).push(change.element);
                    }

                    // Template compatibility: the World.md template expects the
                    // v1 field names, and the API key comes from the user's input
                    // (v2 never echoes credentials).
                    worldData.World = {
                        ...worldMeta,
                        api_key: data.apiKey.trim(),
                        time_current: worldMeta.time_range_current,
                    };
                    const worldApiKey = data.apiKey.trim();
    
                    // Generate unique world name to prevent conflicts
                    const uniqueWorldName = await this.worldService.generateUniqueWorldName(worldName, worldApiKey);
               //     console.log(`[DownloadWorldCommand] Original world name: ${worldName}, Unique name: ${uniqueWorldName}`);
    
                    // Corrected paths to include OnlyWorlds/Worlds/{uniqueWorldName}/Elements
                    const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${uniqueWorldName}`);
                    const elementsFolderPath = normalizePath(`${worldFolderPath}/Elements`);
                    const fs = this.app.vault.adapter;
    
                    // Ensure the World and Elements folders exist
                    await this.createFolderIfNeeded(worldFolderPath);
                    await this.createFolderIfNeeded(elementsFolderPath);
    
                    // Generate world file
                    const worldFilePath = `${worldFolderPath}/World.md`;
                    if (overwrite || !await fs.exists(worldFilePath)) {
                        await this.generateWorldFile(worldData.World, worldFolderPath);
                    }

                    const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest );
                    await createCoreFilesCommand.execute();

                    // Generate element notes in the correct category folders under Elements
                    // (Phase B: frontmatter via writeElement — no Handlebars templates)
                    await this.generateElementNotes(elementsFolderPath, worldData, overwrite);

                    // Update all category folder names with counts
                    await this.worldService.updateAllCategoryFolderNames(uniqueWorldName);

                    // Persist the watermark only after every note landed — a
                    // failed run must re-pull the same changes next time.
                    if (this.plugin && walk.cursor) {
                        this.plugin.settings.syncCursors[worldId] = { cursor: walk.cursor, head: walk.head };
                        await this.plugin.saveSettings();
                    }

                    const changedNote = stored ? ` (${latest.size} changed element${latest.size === 1 ? '' : 's'})` : '';
                    new Notice(`Successfully downloaded world: ${uniqueWorldName}${changedNote}`);
                    if (deleteCount > 0) {
                        new Notice(`${deleteCount} element${deleteCount === 1 ? '' : 's'} deleted on the server — their notes were kept. Remove them manually if desired.`, 10000);
                    }
                } catch (error) {
                    console.error('Error during world download:', error);
                    if (error instanceof V2ApiError) {
                        if (error.status === 401 || error.status === 403) {
                            new Notice('Download failed: Invalid PIN or API key.');
                        } else if (error.status === 429) {
                            new Notice('Download failed: Rate limit exceeded. Please try again later.');
                        } else {
                            new Notice(`Download failed: ${error.message}`, 10000);
                        }
                    } else if (error instanceof Error) {
                        new Notice(`Error fetching world data: ${error.message}`);
                    } else {
                        new Notice('An unknown error occurred during download.');
                    }
                }
            } else {
                new Notice('Please enter a world API key.');
            }
        }).open();
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
        
        // noEscape: note bodies are span-tag markdown, not HTML — field values
        // are plain data. Default escaping turned "The Kid's Family" into
        // "The Kid&#x27;s Family" on disk, which then failed file lookups and
        // uploaded escaped names verbatim.
        const worldTemplate = Handlebars.compile(worldTemplateString, { noEscape: true });
        const worldContent = worldTemplate(worldData);
        const worldFilePath = `${worldFolderPath}/World.md`;
        await fs.write(worldFilePath, worldContent); 
    }
    async generateElementNotes(worldFolderPath: string, data: any, overwrite: boolean) {
        const fs = this.app.vault.adapter;

        // Extract the (unique) world name once — used both for the id->name map's
        // disk fallback and per-category below.
        const pathParts0 = worldFolderPath.split('/');
        const worldsIdx0 = pathParts0.findIndex(part => part === 'Worlds');
        const mapWorldName = worldsIdx0 >= 0 && pathParts0.length > worldsIdx0 + 1
            ? pathParts0[worldsIdx0 + 1]
            : pathParts0[pathParts0.length - 1];

        // Build ONE complete id->name map for link rendering (the S9 fix). Built
        // from the in-memory payload (freshest names) + a raw-disk fallback for
        // ids outside an incremental pull's changed set. metadataCache is NOT
        // consulted — its staleness mid-bulk-write IS the bug. The map returns the
        // NOTE BASENAME form (sanitizeFileName) so the written [[Name]] wikilink
        // resolves by filename to the actual note on disk.
        const idToName = await this.buildIdToNameMap(mapWorldName, data);

        for (const category in Category) {
            if (!isNaN(Number(category)) || !data[category]) continue;
    
            const elements = data[category];
         //   console.log(`[DownloadWorldCommand] Processing category: ${category} with ${elements.length} elements`);
            
            // Find existing category folder or create new one
            // Extract world name more reliably
            const pathParts = worldFolderPath.split('/');
            const worldsIndex = pathParts.findIndex(part => part === 'Worlds');
            const worldName = worldsIndex >= 0 && pathParts.length > worldsIndex + 1 ? pathParts[worldsIndex + 1] : pathParts[pathParts.length - 1];
            
         //   console.log(`[DownloadWorldCommand] Extracted world name: ${worldName}`);
            
            const existingFolder = await this.worldService.findCategoryFolderByBaseName(worldName, category);
            let categoryDirectory: string;
            
            if (existingFolder) {
                categoryDirectory = existingFolder.path;
          //      console.log(`[DownloadWorldCommand] Using existing folder: ${existingFolder.path}`);
            } else {
                // Create folder with base name initially (count will be added later)
                categoryDirectory = normalizePath(`${worldFolderPath}/${category}`);
             //   console.log(`[DownloadWorldCommand] Creating new folder: ${categoryDirectory}`);
                await this.createFolderIfNeeded(categoryDirectory);
            }
    
            for (const element of elements) {
            //    console.log(`[DownloadWorldCommand] Processing element: ${element.name} (ID: ${element.id}) in category: ${category}`);
                
                // First check if an element with this ID already exists
                const existingElementPath = await this.findElementByIdInCategory(categoryDirectory, element.id);
           //     console.log(`[DownloadWorldCommand] Existing element path for ID ${element.id}: ${existingElementPath}`);
                
                if (existingElementPath) {
                    // Element already exists, check if filename needs to be updated
                    const currentFileName = existingElementPath.split('/').pop()?.replace('.md', '') || '';
                    const expectedFileName = element.name;
                    
                    if (currentFileName !== expectedFileName && !currentFileName.startsWith(expectedFileName + ' (')) {
                        // Name has changed, rename the file
                  //      console.log(`[DownloadWorldCommand] Element name changed from "${currentFileName}" to "${expectedFileName}"`);
                        const newFileName = await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id);
                        const newPath = `${categoryDirectory}/${newFileName}`;
                        
                        try {
                            const existingFile = this.app.vault.getAbstractFileByPath(existingElementPath);
                            if (existingFile) {
                                await this.app.fileManager.renameFile(existingFile, newPath);
                                var notePath = newPath;
                           //     console.log(`[DownloadWorldCommand] Renamed element file from ${existingElementPath} to ${newPath}`);
                            } else {
                                var notePath = existingElementPath;
                             //   console.log(`[DownloadWorldCommand] Could not find existing file to rename: ${existingElementPath}`);
                            }
                        } catch (error) {
                            console.error(`[DownloadWorldCommand] Error renaming file: ${error}`);
                            var notePath = existingElementPath; // Fall back to existing path
                        }
                    } else {
                        var notePath = existingElementPath;
                    //(`[DownloadWorldCommand] Element exists, updating: ${notePath}`);
                    }
                } else {
                    // Generate unique filename for new element
                    const uniqueFileName = await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id);
                    var notePath = `${categoryDirectory}/${uniqueFileName}`; 
                }
    
                if (overwrite || existingElementPath || !await fs.exists(notePath)) {
                    // v2 frontmatter format (Phase B). writeElement owns the file
                    // placement (it re-finds by embedded id), preserves extension
                    // fields verbatim, normalizes link ids, and maps the body to
                    // description (or story for Narrative). The raw v2 element body
                    // (bare link ids, extension namespaces intact) goes straight in.
                    await writeElement(
                        this.app,
                        worldName,
                        category,
                        element.id,
                        element,
                        {
                            markSelfWrite: (p) => this.plugin?.autoSync?.markSelfWrite(p),
                            folderPath: categoryDirectory,
                            fileName: notePath.split('/').pop(),
                            idToName,
                        }
                    );
                } else {
                  //  console.log(`[DownloadWorldCommand] Skipping element (already exists and not overwriting): ${notePath}`);
                }
            }
        } 
    }
    
    /**
     * Build the id -> note-basename map used to render link fields as [[Name]]
     * wikilinks during download (the S9 fix). Two sources, payload wins:
     *
     *   1. The in-memory download payload — holds every element's id AND name for
     *      THIS pull. Complete for a full download.
     *   2. Raw-disk fallback — an incremental pull carries only CHANGED elements,
     *      so a link may point at an unchanged element absent from the payload.
     *      Scan existing element notes for this world by READING each file and
     *      parsing its `---` frontmatter block (id + name). metadataCache is never
     *      touched: its cold-cache-mid-write staleness is precisely the bug.
     *
     * The returned name is passed through sanitizeFileName so the [[Name]] target
     * matches the note's on-disk basename and resolves by filename (portability:
     * a moved vault keeps working, no plugin needed). Collision `(N)` suffixes are
     * NOT reflected (a pre-existing limitation shared with the old linkifier).
     * An id in neither source returns null, so writeElement keeps the raw id
     * (dangling / cross-world links are never lost).
     */
    private async buildIdToNameMap(worldName: string, data: any): Promise<(id: string) => string | null> {
        const map = new Map<string, string>();

        // Source 2 (disk) first, so Source 1 (payload) overwrites with the
        // freshest names on any id present in both.
        const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
        const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix));
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const fm = parseRawFrontmatterScalars(content, ['id', 'name']);
                if (fm.id && fm.name) {
                    map.set(fm.id, sanitizeFileName(fm.name));
                }
            } catch { /* unreadable note — skip */ }
        }

        // Source 1 (payload) — every downloaded element, all categories.
        for (const category in Category) {
            if (!isNaN(Number(category)) || !Array.isArray(data[category])) continue;
            for (const element of data[category]) {
                if (element && typeof element.id === 'string' && typeof element.name === 'string' && element.name) {
                    map.set(element.id, sanitizeFileName(element.name));
                }
            }
        }

        return (id: string) => map.get(id) ?? null;
    }

    async linkifyContent(noteContent: string, data: any): Promise<string> {
        // Incremental pulls carry only CHANGED elements, so the pulled data
        // alone can't name every linked id — merge in an id→name index built
        // from the vault's existing notes (2.3.0 smoke test: ids outside the
        // pull window rendered as [[Unknown]], losing the id entirely).
        const vaultIndex = await this.buildVaultNameIndex();
        noteContent = noteContent.replace(/\[\[(.*?)\]\]/g, (match, id) => {
            const name = this.findNameById(id, data) ?? vaultIndex.get(id);
            // Wikilink targets are FILENAMES — sanitize so links to elements
            // with ':' etc. in their names resolve (the note's Name field and
            // the API keep the exact name; only the link/file form changes).
            // Never write [[Unknown]]: an unresolvable id stays as [[<id>]] so
            // identity survives and export can pass it through.
            return name ? `[[${sanitizeFileName(name)}]]` : `[[${id}]]`;
        });

        return noteContent;
    }

    /** Does the vault hold ANY element note for this world? Used to sanity-check
     *  the sync-cursor watermark against vault reality: settings outlive vault
     *  content, and a stored cursor over an empty world folder means an
     *  incremental download would truthfully write nothing (2026-07-16 smoke). */
    private vaultHasElementNotes(worldName: string): boolean {
        const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
        return this.app.vault.getMarkdownFiles().some(f => f.path.startsWith(prefix));
    }

    /** id→name across every element note in the vault (all worlds' notes are
     *  under OnlyWorlds/Worlds/<w>/Elements/; ids are unique across worlds). */
    private async buildVaultNameIndex(): Promise<Map<string, string>> {
        const index = new Map<string, string>();
        const files = this.app.vault.getFiles().filter(f =>
            f.path.startsWith('OnlyWorlds/Worlds/') && f.path.includes('/Elements/') && f.extension === 'md');
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const idMatch = content.match(/>Id<\/span>:\s*(\S+)/);
                const nameMatch = content.match(/>Name<\/span>:\s*(.+)$/m);
                if (idMatch && nameMatch) {
                    index.set(idMatch[1].trim(), nameMatch[1].trim());
                }
            } catch { /* unreadable note — skip */ }
        }
        return index;
    }
    
    findNameById(id: string, data: any): string | undefined { 
        for (const category in Category) {
            if (Array.isArray(data[category])) {
                const found = data[category].find((item: any) => item.id === id);
                if (found) { 
                    return found.name;
                }
            }
        } 
        return undefined; // Return undefined if no match is found
    }

    async findElementByIdInCategory(categoryDirectory: string, elementId: string): Promise<string | null> {
     //   console.log(`[DownloadWorldCommand] Looking for element ID ${elementId} in directory: ${categoryDirectory}`);
        
        const categoryFolder = this.app.vault.getAbstractFileByPath(categoryDirectory);
        
        if (!(categoryFolder instanceof TFolder)) {
          //  console.log(`[DownloadWorldCommand] Category folder not found or not a folder: ${categoryDirectory}`);
            return null;
        }

     //   console.log(`[DownloadWorldCommand] Found ${categoryFolder.children.length} files in category folder`);

        for (const child of categoryFolder.children) {
            if (child instanceof TFile && child.extension === 'md') {
             //   console.log(`[DownloadWorldCommand] Checking file: ${child.path}`);
                try {
                    const content = await this.app.vault.read(child);
                  //  console.log(`[DownloadWorldCommand] File content preview (first 200 chars): ${content.substring(0, 200)}`);
                    
                    // Look for ID in the content - this regex looks for the ID field in the element
                    // Look for ID in various possible formats
                    const idMatch = content.match(/^- \*\*ID:\*\* (.+)$/m) || 
                                  content.match(/^- .*Id.*: (.+)$/m) ||
                                  content.match(/Id.*: (.+)$/m);
                    
                    if (idMatch) {
                     //   console.log(`[DownloadWorldCommand] Found ID in file ${child.path}: ${idMatch[1].trim()}`);
                        if (idMatch[1].trim() === elementId) {
                         //   console.log(`[DownloadWorldCommand] MATCH! Found existing element at: ${child.path}`);
                            return child.path;
                        }
                    } else {
                    //    console.log(`[DownloadWorldCommand] No ID found in file: ${child.path}`);
                    }
                } catch (error) {
                    console.error(`Error reading element file: ${child.path}`, error);
                }
            }
        }
        
       // console.log(`[DownloadWorldCommand] No existing element found for ID: ${elementId}`);
        return null;
    }
}
