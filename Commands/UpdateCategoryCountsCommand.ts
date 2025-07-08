import { App, Notice } from 'obsidian';
import { WorldService } from '../Scripts/WorldService';

export class UpdateCategoryCountsCommand {
    app: App;
    manifest: any;
    private worldService: WorldService;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = new WorldService(app);
    }

    async execute(): Promise<void> {
        try {
            const worldName = await this.worldService.getWorldName();
            await this.worldService.updateAllCategoryFolderNames(worldName);
            new Notice('Category folder counts updated successfully!');
        } catch (error) {
            console.error('Error updating category counts:', error);
            new Notice('Failed to update category folder counts');
        }
    }
}