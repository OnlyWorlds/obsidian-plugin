import { App, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
import { v7 as uuidv7 } from 'uuid';
import { writeElement } from '../vault/element-file';

export class CreateElementCommand {
    app: App;
    manifest: any;
    worldService: WorldService;

    constructor(app: App, manifest: any, worldService: WorldService) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
    }

    async execute(category: string, name: string, worldName?: string, openFile: boolean = true): Promise<void> {
        const uuid = uuidv7();
        // v3.2: a fresh element carries its FULL field set — base + numbers +
        // links as frontmatter properties, every text field as an empty `##`
        // body section. 3.0-3.1 created id + name only and expected the user to
        // add Properties by hand, which meant knowing 38 snake_case field names
        // that nothing in the UI ever showed them. writeElement builds both
        // halves from FIELD_SCHEMA, so an empty note IS the field reference.
        const topWorld = worldName || await this.worldService.getActiveWorldName();
        try {
            // Resolve the (possibly count-suffixed) category folder + a collision-free
            // filename, so we write into the same folder the vault already uses.
            const existingFolder = await this.worldService.findCategoryFolderByBaseName(topWorld, category);
            const folderPath = existingFolder
                ? existingFolder.path
                : normalizePath(`OnlyWorlds/Worlds/${topWorld}/Elements/${category}`);
            const fileName = await this.worldService.generateUniqueFileName(folderPath, name, uuid);
            const file = await writeElement(this.app, topWorld, category, uuid, { name }, {
                folderPath,
                fileName,
                scaffoldEmptyFields: true,
            });
            new Notice(`New ${category.toLowerCase()} created: ${name}`);
            await this.worldService.updateCategoryFolderName(topWorld, category);
            if (openFile) {
                await this.openNoteInNewPane(file);
            }
        } catch (error) {
            console.error(`Failed to create ${category} note`, error);
            new Notice(`Failed to create ${category}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
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
