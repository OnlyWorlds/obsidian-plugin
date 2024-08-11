import { App, Notice, Modal, FileSystemAdapter, normalizePath } from 'obsidian';
import Handlebars from 'handlebars';
import { Category } from '../enums';
import { WorldPasteModal } from 'Modals/WorldPasteModal'; 
import { CreateTemplatesCommand } from './CreateTemplatesCommand';
import { CreateSettingsCommand } from './CreateSettingsCommand';
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
            const worldName = worldData ? worldData.name : null;

            if (!worldName) {
                new Notice('No valid world data found.');
                return;
            }

            const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${worldName}`);
            const elementsFolderPath = normalizePath(`${worldFolderPath}/Elements`);
            const fs = this.app.vault.adapter as FileSystemAdapter;

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
        const fs = this.app.vault.adapter as FileSystemAdapter;
        const worldTemplatePath = normalizePath(`${this.app.vault.configDir}/plugins/obsidian-plugin/Handlebars/WorldHandlebar.md`);
        const worldTemplateText = await fs.read(worldTemplatePath);
        const worldTemplate = Handlebars.compile(worldTemplateText);
        const worldContent = worldTemplate(worldData);
        const worldFilePath = `${worldFolderPath}/World.md`;
        await fs.write(worldFilePath, worldContent);
        new Notice(`World file created: ${worldFilePath}`);
    }

    async generateElementNotes(worldFolderPath: string, data: any, overwrite: boolean) {
        const fs = this.app.vault.adapter as FileSystemAdapter;

        for (const category in Category) {
            if (!isNaN(Number(category)) || !data[category]) continue;

            const elements = data[category];
            const categoryDirectory = normalizePath(`${worldFolderPath}/${category}`);
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
}
