import Handlebars from 'handlebars';
import { WorldPasteModal } from 'Modals/WorldPasteModal';
import { App, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { WorldService, sanitizeFileName } from 'Scripts/WorldService';
import { Category } from '../enums';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';
import { writeElement } from '../vault/element-file';

export class PasteWorldCommand {
    app: App;
    manifest: any;
    private worldService: WorldService;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = new WorldService(app);
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

            const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest);
            await createCoreFilesCommand.execute();

            // Generate element notes in the correct category folders under Elements
            await this.generateElementNotes(elementsFolderPath, worldDataJson, false);

            // Update all category folder names with counts
            await this.worldService.updateAllCategoryFolderNames(targetWorldName);

            if (existingWorldName) {
                new Notice(`Successfully updated existing world: ${targetWorldName}`);
            } else {
                new Notice(`Successfully created new world: ${targetWorldName}`);
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

    async generateElementNotes(worldFolderPath: string, data: any, overwrite: boolean) {
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

        for (const category in Category) {
            if (!isNaN(Number(category)) || !Array.isArray(data[category])) continue;

            const elements = data[category];
            const existingFolder = await this.worldService.findCategoryFolderByBaseName(worldName, category);
            const categoryDirectory = existingFolder
                ? existingFolder.path
                : normalizePath(`${worldFolderPath}/${category}`);
            if (!existingFolder) await this.createFolderIfNeeded(categoryDirectory);

            for (const element of elements) {
                if (!element || typeof element.id !== 'string') continue;

                // Reuse an existing note for this id, else mint a unique filename.
                const existingElementPath = await this.findElementByIdInCategory(categoryDirectory, element.id);
                const fileName = existingElementPath
                    ? existingElementPath.split('/').pop()
                    : await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id);

                // Same frontmatter writer as Download (Phase B). writeElement owns
                // placement (re-finds by embedded id), preserves extension fields,
                // renders link ids as [[Name]] wikilinks, maps body to
                // description/story. No Handlebars templates, no span format.
                await writeElement(
                    this.app,
                    worldName,
                    category,
                    element.id,
                    element,
                    { folderPath: categoryDirectory, fileName, idToName }
                );
            }
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

    async findWorldByApiKey(apiKey: string): Promise<string | null> {
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

    async findElementByIdInCategory(categoryDirectory: string, elementId: string): Promise<string | null> {
        const categoryFolder = this.app.vault.getAbstractFileByPath(categoryDirectory);
        
        if (!(categoryFolder instanceof TFolder)) {
            return null;
        }

        for (const child of categoryFolder.children) {
            if (child instanceof TFile && child.extension === 'md') {
                try {
                    const content = await this.app.vault.read(child);
                //    console.log(`[PasteWorldCommand] Checking file: ${child.path}`);
                //    console.log(`[PasteWorldCommand] File content preview (first 200 chars): ${content.substring(0, 200)}`);
                    
                    // Match the id in either format: frontmatter `id:` (2.4.0)
                    // or the legacy span/bold forms (older notes not yet migrated).
                    const idMatch = content.match(/^id:\s*(\S+)/m) ||
                                  content.match(/^- \*\*ID:\*\* (.+)$/m) ||
                                  content.match(/^- .*Id.*: (.+)$/m) ||
                                  content.match(/Id.*: (.+)$/m);

                    if (idMatch) {
                    //    console.log(`[PasteWorldCommand] Found ID in file ${child.path}: ${idMatch[1].trim()}`);
                        if (idMatch[1].trim() === elementId) {
                    //        console.log(`[PasteWorldCommand] MATCH! Found existing element at: ${child.path}`);
                            return child.path;
                        }
                    } else {
                    //    console.log(`[PasteWorldCommand] No ID found in file: ${child.path}`);
                    }
                } catch (error) {
                    console.error(`Error reading element file: ${child.path}`, error);
                }
            }
        }
        
        return null;
    }
}
