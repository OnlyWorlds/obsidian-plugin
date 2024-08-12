import { App, Notice } from 'obsidian';
import { Category } from '../enums'; 

export class CreateCategoryFoldersCommand {
    app: App;
    manifest: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute() {
        const parentFolder = 'Elements';
        await this.createFolderIfNeeded(parentFolder);

        for (const category in Category) {
            if (isNaN(Number(category))) { // Check to only use string keys, not numeric values
                await this.createFolderIfNeeded(`${parentFolder}/${category}`);
            }
        }
    }

    async createFolderIfNeeded(folderPath: string) {
        let existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!existingFolder) {
            try {
                await this.app.vault.createFolder(folderPath);
               // new Notice(`Created folder: ${folderPath}`);
            } catch (error) {
                console.error(`Error creating folder: ${folderPath}`, error);
            }
        } else {
           
        }
    }
}
