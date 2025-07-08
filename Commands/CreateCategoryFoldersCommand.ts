import { App, Notice } from 'obsidian';
import { Category } from '../enums';
import { WorldService } from '../Scripts/WorldService'; 

export class CreateCategoryFoldersCommand {
    app: App;
    manifest: any;
    private worldService: WorldService;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = new WorldService(app);
    }

    async execute() {
        const parentFolder = 'Elements';
        await this.createFolderIfNeeded(parentFolder);

        for (const category in Category) {
            if (isNaN(Number(category))) { // Check to only use string keys, not numeric values
                // Create folders with base names initially (counts will be added later when elements exist)
                await this.createFolderIfNeeded(`${parentFolder}/${category}`);
            }
        }
        
        // After folders are created, update their names with counts
        const worldName = await this.worldService.getWorldName();
        await this.worldService.updateAllCategoryFolderNames(worldName);
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
