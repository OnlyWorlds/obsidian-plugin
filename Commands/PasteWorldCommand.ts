import Handlebars from 'handlebars';
import { WorldPasteModal } from 'Modals/WorldPasteModal';
import { App, FileSystemAdapter, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { Category } from '../enums';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';

export class PasteWorldCommand {
    app: App;
    manifest: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
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

            // Find existing world by API key or use the world name
            const existingWorldName = await this.findWorldByApiKey(apiKey);
            const targetWorldName = existingWorldName || worldName;

            const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${targetWorldName}`);
            const elementsFolderPath = normalizePath(`${worldFolderPath}/Elements`);
            if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
                new Notice('Unexpected adapter type. This feature requires a file system-based vault.');
                return; 
            }             
            const fs: FileSystemAdapter = this.app.vault.adapter;

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
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            new Notice('Unexpected adapter type. This feature requires a file system-based vault.');
            return; 
        }             
        const fs: FileSystemAdapter = this.app.vault.adapter; 
        
        // Add image_display field based on image_url
        if (worldData.image_url) {
            worldData.image_display = `![World Image](${worldData.image_url})`;
        } else {
            worldData.image_display = "None";
        }
        
        const worldTemplate = Handlebars.compile(worldTemplateString);
        const worldContent = worldTemplate(worldData);
        const worldFilePath = `${worldFolderPath}/World.md`;
        await fs.write(worldFilePath, worldContent); 
    }

    async generateElementNotes(worldFolderPath: string, data: any, overwrite: boolean) {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            new Notice('Unexpected adapter type. This feature requires a file system-based vault.');
            return; 
        }
    
        const fs: FileSystemAdapter = this.app.vault.adapter;
    
        for (const category in Category) {
            if (!isNaN(Number(category)) || !data[category]) continue;
    
            const elements = data[category];
            const categoryDirectory = normalizePath(`${worldFolderPath}/${category}`);
    
            // Check if category folder exists, create if not
            if (!this.app.vault.getAbstractFileByPath(categoryDirectory)) {
                await this.app.vault.createFolder(categoryDirectory);
            }
    
            for (const element of elements) {
                // First check if an element with this ID already exists
                const existingElementPath = await this.findElementByIdInCategory(categoryDirectory, element.id);
                const notePath = existingElementPath || `${categoryDirectory}/${element.name}.md`;
    
                if (overwrite || existingElementPath || !await fs.exists(notePath)) {
                    // Use the Handlebars templates from the user's vault
                    const templatePath = normalizePath(`OnlyWorlds/PluginFiles/Handlebars/${category}Handlebar.md`);
                    let templateText: string;
    
                    if (await fs.exists(templatePath)) {
                        templateText = await fs.read(templatePath);
                    } else {
                        // Log an error if the template doesn't exist and skip note creation for this category
                        console.error(`Handlebars not found: ${templatePath}`);
                        new Notice(`Handlebars not found for ${category}, skipping note creation.`);
                        continue;
                    }
    
                    const template = Handlebars.compile(templateText);
                    let noteContent = template(element);
    
                    // Replace links with proper IDs
                    noteContent = await this.linkifyContent(noteContent, data);
    
                    // Write the note content to the appropriate file path
                    await fs.write(notePath, noteContent); 
                }
            }
        }
    }
    

    async linkifyContent(noteContent: string, data: any): Promise<string> {
        noteContent = noteContent.replace(/\[\[(.*?)\]\]/g, (match, id) => {
            const name = this.findNameById(id, data); 
            return name ? `[[${name}]]` : `[[Unknown]]`;
        });
     
        return noteContent;
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
        return undefined;
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
                    // Look for ID in the content - this regex looks for the ID field in the element
                    const idMatch = content.match(/^- \*\*ID:\*\* (.+)$/m);
                    
                    if (idMatch && idMatch[1].trim() === elementId) {
                        return child.path;
                    }
                } catch (error) {
                    console.error(`Error reading element file: ${child.path}`, error);
                }
            }
        }
        
        return null;
    }
}
