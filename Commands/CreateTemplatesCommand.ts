import { App, Notice, normalizePath } from 'obsidian';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { Category } from '../enums';
import { v7 as uuidv7 } from 'uuid';

export class CreateTemplatesCommand {
    app: App;
    manifest: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }

    hasBasePath(adapter: any): adapter is { getBasePath: () => string } {
        return typeof adapter.getBasePath === 'function';
    }


    async execute(): Promise<void> {
        const templateFolder = normalizePath('OnlyWorlds/Templates');
        const categories = Object.keys(Category).filter(key => isNaN(Number(key)));
        const configDir = this.app.vault.configDir;  // Retrieve the configured directory from user settings

        // Ensure the template folder exists
        await this.createFolderIfNeeded(templateFolder);
        console.log('CREATE TEMPLATE');
        for (const category of categories) {
            const fileName = `${category}.md`;
            // Use the user-configured directory for source path
            var sourcePath = "";
            const adapter = this.app.vault.adapter;
            if (this.hasBasePath(adapter)) {
                sourcePath = resolve(adapter.getBasePath(), '.obsidian', 'plugins', 'onlyworlds-builder', 'Templates', fileName);
            } else {
                console.error("Adapter does not support getBasePath");
            }
           
            const targetPath = normalizePath(`${templateFolder}/${fileName}`);

            // Check if the target file already exists to prevent unnecessary creation attempts
            if (!this.app.vault.getAbstractFileByPath(targetPath)) {
                if (existsSync(sourcePath)) {
                    let content = readFileSync(sourcePath, 'utf-8');
                    const uuid = uuidv7();
                    content = content.replace("{{id}}", uuid);  // Assume {{id}} is where the UUID should go

                    // Create the file only if it does not already exist
                    await this.app.vault.create(targetPath, content); 
                } else {
                    console.error(`Template file not found: ${sourcePath}`);
                    new Notice('Template file not found.');
                }
            } else {
                // Log or handle existing file scenario
            }
        }
    }

    async createFolderIfNeeded(folderPath: string) {
        try {
            const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!existingFolder) {
                await this.app.vault.createFolder(folderPath); 
            } else {
                // Handle case where folder already exists
            }
        } catch (error) {
            console.error(`Error creating folder: ${folderPath}`, error);
            new Notice('Error: Could not create folder.');
        }
    }
}
