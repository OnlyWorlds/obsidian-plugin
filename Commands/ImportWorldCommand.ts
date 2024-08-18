import { App, Notice, requestUrl, FileSystemAdapter, normalizePath } from 'obsidian';
import Handlebars from 'handlebars';
import { Category } from '../enums';
import { WorldKeyModal } from 'Modals/WorldKeyModal'; 
import { CreateTemplatesCommand } from './CreateTemplatesCommand';
import { CreateSettingsCommand } from './CreateSettingsCommand';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';

export class ImportWorldCommand {
    app: App;
    manifest: any;
    private apiUrl = 'https://www.onlyworlds.com/api/worlddata/';

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }
    async execute(overwrite: boolean = false) {
        new WorldKeyModal(this.app, async (worldKey: string) => {
            if (worldKey.length === 10) {
                try {
                    const response = await requestUrl({
                        url: this.apiUrl + worldKey,
                        method: 'GET'
                    });
    
                    if (response.status !== 200) {
                        new Notice('Failed to fetch world data: ' + response.status);
                        return;
                    }
    
                    const data = JSON.parse(response.text);
                    const worldData = data['World'];
                    const worldName = worldData ? worldData.name : null;
    
                    if (!worldName) {
                        new Notice('No valid world data found.');
                        return;
                    }
    
                    // Corrected paths to include OnlyWorlds/Worlds/{worldName}/Elements
                    const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${worldName}`);
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
                        await this.generateWorldFile(worldData, worldFolderPath);
                    }

                    const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest );
                    await createCoreFilesCommand.execute(); 

                    // Generate element notes in the correct category folders under Elements
                    await this.generateElementNotes(elementsFolderPath, data, overwrite);
                } catch (error) {
                    console.error('Error during world import:', error);
                    new Notice('Error fetching world data: ' + error.message);
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
        const worldTemplatePath = normalizePath(`${this.app.vault.configDir}/plugins/obsidian-plugin/Handlebars/WorldHandlebar.md`);
        const worldTemplateText = await fs.read(worldTemplatePath);
        const worldTemplate = Handlebars.compile(worldTemplateText);
        const worldContent = worldTemplate(worldData);
        const worldFilePath = `${worldFolderPath}/World.md`;
        await fs.write(worldFilePath, worldContent);
        console.log(`World file created at: ${worldFilePath}`);
        new Notice(`World file created: ${worldFilePath}`);
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
                const notePath = `${categoryDirectory}/${element.name}.md`;
                
                if (overwrite || !await fs.exists(notePath)) {
                    const templatePath = normalizePath(`${this.app.vault.configDir}/plugins/obsidian-plugin/Handlebars/${category}Handlebar.md`);
                    const templateText = await fs.read(templatePath);
                    const template = Handlebars.compile(templateText);
                    let noteContent = template(element);
                    
                    noteContent = await this.linkifyContent(noteContent, data);
                    
                    await fs.write(notePath, noteContent);
                   // new Notice(`Note created for: ${element.name}`);
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
}
