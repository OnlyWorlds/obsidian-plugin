import Handlebars from 'handlebars';
import { WorldImportData, WorldImportModal } from 'Modals/WorldImportModal';
import { App, FileSystemAdapter, normalizePath, Notice, requestUrl, TFile, TFolder } from 'obsidian';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { WorldService } from 'Scripts/WorldService';
import { Category } from '../enums';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';

export class ImportWorldCommand {
    app: App;
    manifest: any;
    private worldService: WorldService; 
    // private apiUrl = 'http://127.0.0.1:8000/api/worldsync/send/'; 
     private apiUrl = 'https://www.onlyworlds.com/api/worldsync/send/'; 

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = new WorldService(app);
    }
    
    async execute(overwrite: boolean = false) {
        new WorldImportModal(this.app, async (data: WorldImportData | null) => {
            if (!data) {
                // User cancelled the operation
                return;
            }
            
            if (data.apiKey.length === 10) {
                try {
                    const response = await requestUrl({
                        url: this.apiUrl,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            api_key: data.apiKey,
                            pin: data.pin
                        })
                    });
    
                    if (response.status !== 200) {
                        if (response.status === 403) {
                            new Notice('Import failed: Invalid PIN or API key.');
                        } else if (response.status === 429) {
                            new Notice('Import failed: Rate limit exceeded. Please try again later.');
                        } else {
                            new Notice(`Failed to fetch world data: ${response.status}`);
                        }
                        return;
                    }
    
                    const worldData = JSON.parse(response.text);
                    const worldName = worldData.World ? worldData.World.name : null;
                    const worldApiKey = worldData.World ? worldData.World.api_key : null;
    
                    if (!worldName) {
                        new Notice('No valid world data found.');
                        return;
                    }
    
                    // Generate unique world name to prevent conflicts
                    const uniqueWorldName = await this.worldService.generateUniqueWorldName(worldName, worldApiKey);
               //     console.log(`[ImportWorldCommand] Original world name: ${worldName}, Unique name: ${uniqueWorldName}`);
    
                    // Corrected paths to include OnlyWorlds/Worlds/{uniqueWorldName}/Elements
                    const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${uniqueWorldName}`);
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
                    if (overwrite || !await fs.exists(worldFilePath)) {
                        await this.generateWorldFile(worldData.World, worldFolderPath);
                    }

                    const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest );
                    await createCoreFilesCommand.execute(); 

                    // Generate element notes in the correct category folders under Elements
                    await this.generateElementNotes(elementsFolderPath, worldData, overwrite);

                    // Update all category folder names with counts
                    await this.worldService.updateAllCategoryFolderNames(uniqueWorldName);

                    new Notice(`Successfully imported world: ${uniqueWorldName}`);
                } catch (error) {
                    console.error('Error during world import:', error);
                    if (error instanceof Error) {
                        if (error.message.includes('status 403')) {
                            new Notice('Import failed: Invalid PIN or API key.');
                        } else if (error.message.includes('status 429')) {
                            new Notice('Import failed: Rate limit exceeded. Please try again later.');
                        } else {
                            new Notice(`Error fetching world data: ${error.message}`);
                        }
                    } else {
                        new Notice('An unknown error occurred during import.');
                    }
                }
            } else {
                new Notice('Invalid world key. Please ensure it is a 10-digit number.');
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
         //   console.log(`[ImportWorldCommand] Processing category: ${category} with ${elements.length} elements`);
            
            // Find existing category folder or create new one
            // Extract world name more reliably
            const pathParts = worldFolderPath.split('/');
            const worldsIndex = pathParts.findIndex(part => part === 'Worlds');
            const worldName = worldsIndex >= 0 && pathParts.length > worldsIndex + 1 ? pathParts[worldsIndex + 1] : pathParts[pathParts.length - 1];
            
         //   console.log(`[ImportWorldCommand] Extracted world name: ${worldName}`);
            
            const existingFolder = await this.worldService.findCategoryFolderByBaseName(worldName, category);
            let categoryDirectory: string;
            
            if (existingFolder) {
                categoryDirectory = existingFolder.path;
          //      console.log(`[ImportWorldCommand] Using existing folder: ${existingFolder.path}`);
            } else {
                // Create folder with base name initially (count will be added later)
                categoryDirectory = normalizePath(`${worldFolderPath}/${category}`);
             //   console.log(`[ImportWorldCommand] Creating new folder: ${categoryDirectory}`);
                await this.createFolderIfNeeded(categoryDirectory);
            }
    
            for (const element of elements) {
            //    console.log(`[ImportWorldCommand] Processing element: ${element.name} (ID: ${element.id}) in category: ${category}`);
                
                // First check if an element with this ID already exists
                const existingElementPath = await this.findElementByIdInCategory(categoryDirectory, element.id);
           //     console.log(`[ImportWorldCommand] Existing element path for ID ${element.id}: ${existingElementPath}`);
                
                if (existingElementPath) {
                    // Element already exists, check if filename needs to be updated
                    const currentFileName = existingElementPath.split('/').pop()?.replace('.md', '') || '';
                    const expectedFileName = element.name;
                    
                    if (currentFileName !== expectedFileName && !currentFileName.startsWith(expectedFileName + ' (')) {
                        // Name has changed, rename the file
                  //      console.log(`[ImportWorldCommand] Element name changed from "${currentFileName}" to "${expectedFileName}"`);
                        const newFileName = await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id);
                        const newPath = `${categoryDirectory}/${newFileName}`;
                        
                        try {
                            const existingFile = this.app.vault.getAbstractFileByPath(existingElementPath);
                            if (existingFile) {
                                await this.app.fileManager.renameFile(existingFile, newPath);
                                var notePath = newPath;
                           //     console.log(`[ImportWorldCommand] Renamed element file from ${existingElementPath} to ${newPath}`);
                            } else {
                                var notePath = existingElementPath;
                             //   console.log(`[ImportWorldCommand] Could not find existing file to rename: ${existingElementPath}`);
                            }
                        } catch (error) {
                            console.error(`[ImportWorldCommand] Error renaming file: ${error}`);
                            var notePath = existingElementPath; // Fall back to existing path
                        }
                    } else {
                        var notePath = existingElementPath;
                    //(`[ImportWorldCommand] Element exists, updating: ${notePath}`);
                    }
                } else {
                    // Generate unique filename for new element
                    const uniqueFileName = await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id);
                    var notePath = `${categoryDirectory}/${uniqueFileName}`; 
                }
    
                if (overwrite || existingElementPath || !await fs.exists(notePath)) { 
                    
                    // Fetch the template from the user's vault
                    const templatePath = normalizePath(`OnlyWorlds/PluginFiles/Handlebars/${category}Handlebar.md`);
                    let templateText: string;
    
                    if (await fs.exists(templatePath)) {
                        templateText = await fs.read(templatePath);
                    } else {
                        // If the template doesn't exist, log an error and skip the note creation
                        console.error(`Handlebars not found: ${templatePath}`);
                        new Notice(`Handlebars not found for ${category}, skipping note creation.`);
                        continue;
                    }
    
                    const template = Handlebars.compile(templateText);
                    let noteContent = template(element);
    
                    // Process the content to replace links with proper IDs
                    noteContent = await this.linkifyContent(noteContent, data);
    
                    // Write the note content to the appropriate file path
                    await fs.write(notePath, noteContent);  
                } else {
                  //  console.log(`[ImportWorldCommand] Skipping element (already exists and not overwriting): ${notePath}`);
                }
            }
        } 
    }
    
    async linkifyContent(noteContent: string, data: any): Promise<string> { 
        // Adjusted to match [[ID]] format as well
        noteContent = noteContent.replace(/\[\[(.*?)\]\]/g, (match, id) => {
            const name = this.findNameById(id, data); 
            return name ? `[[${name}]]` : `[[Unknown]]`; // Maintain markdown link format
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
        return undefined; // Return undefined if no match is found
    }

    async findElementByIdInCategory(categoryDirectory: string, elementId: string): Promise<string | null> {
     //   console.log(`[ImportWorldCommand] Looking for element ID ${elementId} in directory: ${categoryDirectory}`);
        
        const categoryFolder = this.app.vault.getAbstractFileByPath(categoryDirectory);
        
        if (!(categoryFolder instanceof TFolder)) {
          //  console.log(`[ImportWorldCommand] Category folder not found or not a folder: ${categoryDirectory}`);
            return null;
        }

     //   console.log(`[ImportWorldCommand] Found ${categoryFolder.children.length} files in category folder`);

        for (const child of categoryFolder.children) {
            if (child instanceof TFile && child.extension === 'md') {
             //   console.log(`[ImportWorldCommand] Checking file: ${child.path}`);
                try {
                    const content = await this.app.vault.read(child);
                  //  console.log(`[ImportWorldCommand] File content preview (first 200 chars): ${content.substring(0, 200)}`);
                    
                    // Look for ID in the content - this regex looks for the ID field in the element
                    // Look for ID in various possible formats
                    const idMatch = content.match(/^- \*\*ID:\*\* (.+)$/m) || 
                                  content.match(/^- .*Id.*: (.+)$/m) ||
                                  content.match(/Id.*: (.+)$/m);
                    
                    if (idMatch) {
                     //   console.log(`[ImportWorldCommand] Found ID in file ${child.path}: ${idMatch[1].trim()}`);
                        if (idMatch[1].trim() === elementId) {
                         //   console.log(`[ImportWorldCommand] MATCH! Found existing element at: ${child.path}`);
                            return child.path;
                        }
                    } else {
                    //    console.log(`[ImportWorldCommand] No ID found in file: ${child.path}`);
                    }
                } catch (error) {
                    console.error(`Error reading element file: ${child.path}`, error);
                }
            }
        }
        
       // console.log(`[ImportWorldCommand] No existing element found for ID: ${elementId}`);
        return null;
    }
}
