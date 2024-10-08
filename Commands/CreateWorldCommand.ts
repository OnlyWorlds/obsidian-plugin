import { App, Notice, FileSystemAdapter, TFile, PluginManifest } from 'obsidian';
 import { v7 as uuidv7 } from 'uuid';

import Handlebars from 'handlebars';
import { resolve } from 'path';
import { Category } from '../enums'; 
import { WorldNameModal } from 'Modals/WorldNameModal';
import { CreateSettingsCommand } from './CreateSettingsCommand';
import { CreateReadmeCommand } from './CreateReadmeCommand';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';

export class CreateWorldCommand {
    app: App;
    manifest: PluginManifest;

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }


    async execute() { 
        try {
            const worldName = await this.getWorldName();
            if (!worldName) {
                console.log("World creation cancelled: no world name provided.");
                return;  // User cancelled the input
            }

            // Create base and subdirectories for the world
            const worldBasePath = `OnlyWorlds/Worlds/${worldName}`;
            await this.createFolderIfNeeded(worldBasePath);
            const elementsPath = `${worldBasePath}/Elements`;
            await this.createFolderIfNeeded(elementsPath);
            // Create folders for each category
            for (const category in Category) {
                if (isNaN(Number(category))) {  // Skip numeric keys of the enum
                    await this.createFolderIfNeeded(`${elementsPath}/${category}`);
                }
            }

            // Create world overview note
            const worldData = this.collectWorldData(worldName);
            const worldNoteContent = this.compileWorldNote(worldData);
            await this.app.vault.create(`${worldBasePath}/World.md`, worldNoteContent);

            const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest );
            await createCoreFilesCommand.execute(); 

            new Notice('Successfully created world: ' + worldName);
        } catch (error) {
            console.error("Error during world creation:", error);
            new Notice('Failed to create world.');
        }
    }

    async getWorldName(): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new WorldNameModal(this.app, resolve);
            modal.open();
        });
    }

    async createFolderIfNeeded(folderPath: string) {
        let existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!existingFolder) {
            try {
                await this.app.vault.createFolder(folderPath);
          //      new Notice(`Created folder: ${folderPath}`);
            } catch (error) {
                console.error(`Error creating folder: ${folderPath}`, error);
            }
        } else {
  
        }
    }

    collectWorldData(worldName: string): any {
        // Enhanced data collection with world name
        const worldId = uuidv7(); 

        return {
            id: worldId,
            api_key: "0000000000",
            name: worldName,
            description: ``,
            user_id: "",
            ow_version: "16.10",
            image_url: "",
            focus_text: "",
            time_format_names: "Eon, Era, Period, Epoch, Age, Year, Month, Day, Hour, Minute, Second",
            time_format_equivalents: "Eon, Era, Period, Epoch, Age, Year, Month, Day, Hour, Minute, Second",
            time_basic_unit: "Year",
            time_current: 0,
            time_range_min: 0,
            time_range_max: 100
        };
    }

    compileWorldNote(data: any): string {
        const template = Handlebars.compile(worldTemplateString);
        return template(data);
    }
}
