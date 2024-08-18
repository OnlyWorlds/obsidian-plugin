import { App, TFile, Notice, normalizePath, WorkspaceLeaf, TFolder } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
import { v7 as uuidv7 } from 'uuid';

export class CreateElementCommand {
    app: App;
    manifest: any;
    worldService: WorldService;

    constructor(app: App, manifest: any, worldService: WorldService) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
    }

    async execute(category: string, name: string): Promise<void> {
        const uuid = uuidv7();
        const templateContent = await this.getTemplateContent(category);
        if (!templateContent) {
            new Notice(`Template for ${category} not found.`);
            return;
        } 
        await this.createNoteInCorrectFolder(templateContent, category, uuid, name);
    }
    

    async getTemplateContent(category: string): Promise<string | null> {
        const templatePath = normalizePath(`OnlyWorlds/Templates/${category}.md`);
        const templateFile = this.app.vault.getAbstractFileByPath(templatePath);
        if (templateFile instanceof TFile) {
            return this.app.vault.read(templateFile);
        }
        return null;
    }
    insertNameInTemplate(content: string, name: string): string {
        const lines = content.split('\n');
        const nameLineIndex = lines.findIndex(line => line.includes('Name</span>:'));
        if (nameLineIndex !== -1) {
            lines[nameLineIndex] = lines[nameLineIndex].replace('Name</span>:', `Name</span>: ${name}`);
        }
        return lines.join('\n');
    }

    insertIdInTemplate(content: string, id: string): string {
        const lines = content.split('\n');
        const idLineIndex = lines.findIndex(line => line.includes('Id</span>:')); 
        if (idLineIndex !== -1) {
            lines[idLineIndex] = lines[idLineIndex].replace('Id</span>:', `Id</span>: ${id}`);
        }
        return lines.join('\n');
    }


    async createNoteInCorrectFolder(content: string, category: string, id: string, name: string): Promise<void> {
        const topWorld =  await this.worldService.getWorldName();
        const worldFolder = normalizePath(`OnlyWorlds/Worlds/${topWorld}/Elements/${category}`);
        await this.createFolderIfNeeded(worldFolder);
    
        let newNotePath = normalizePath(`${worldFolder}/${name}.md`);  // Use the provided name for the file
        newNotePath = await this.generateUniqueFilename(worldFolder, name, 0);
    
        // Insert the name and ID into the template content
        content = this.insertNameInTemplate(content, name);
        content = this.insertIdInTemplate(content, id);
    
        try {
            const createdFile = await this.app.vault.create(newNotePath, content);
            new Notice(`New ${category} created with Name: ${name}`);
            this.openNoteInNewPane(createdFile);
        } catch (error) {
            console.error(`Failed to create note: ${newNotePath}`, error);
            new Notice(`Failed to create note: ${newNotePath}`);
        }
    }
    
    
    async generateUniqueFilename(folderPath: string, baseName: string, index: number): Promise<string> {
        let testPath = normalizePath(`${folderPath}/${baseName}${index ? ` ${index}` : ''}.md`);
        while (await this.app.vault.adapter.exists(testPath)) {
            index++;
            testPath = normalizePath(`${folderPath}/${baseName} ${index}.md`);
        }
        
        return testPath;
    }

    async openNoteInNewPane(file: TFile) {
        const leaf = this.app.workspace.getLeaf(true);
        await leaf.openFile(file);
    }

    async determineTopWorldFolder(): Promise<string> {
        const worldsPath = normalizePath('OnlyWorlds/Worlds');
        const worldsFolder = this.app.vault.getAbstractFileByPath(worldsPath);
        if (worldsFolder instanceof TFolder) {
            const subFolders = worldsFolder.children.filter(child => child instanceof TFolder);
            return subFolders.length > 0 ? subFolders[0].name : 'DefaultWorld';
        }
        return 'DefaultWorld';
    }

    async createFolderIfNeeded(folderPath: string): Promise<void> {
        const normalizedPath = normalizePath(folderPath);
        let existingFolder = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!existingFolder) {
            try {
                await this.app.vault.createFolder(normalizedPath);
            //    new Notice(`Created folder: ${normalizedPath}`);
            } catch (error) {
                console.error(`Error creating folder: ${normalizedPath}`, error);
            }
        }
    }
}
