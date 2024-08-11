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

    async execute(): Promise<void> {
        const templateFolder = normalizePath('OnlyWorlds/Templates');
        const categories = Object.keys(Category).filter(key => isNaN(Number(key)));

        // Ensure the template folder exists
        await this.createFolderIfNeeded(templateFolder);

        for (const category of categories) {
            const fileName = `${category}.md`;
            const sourcePath = resolve((this.app.vault.adapter as any).getBasePath(), '.obsidian', 'plugins', 'obsidian-plugin', 'Templates', fileName);
            const targetPath = normalizePath(`${templateFolder}/${fileName}`);

            // Check if the target file already exists to prevent unnecessary creation attempts
            if (!this.app.vault.getAbstractFileByPath(targetPath)) {
                if (existsSync(sourcePath)) {
                    let content = readFileSync(sourcePath, 'utf-8');
                    const uuid = uuidv7();
                    content = content.replace("{{id}}", uuid);  // Assume {{id}} is where the UUID should go

                    // Create the file only if it does not already exist
                    await this.app.vault.create(targetPath, content);
                  //  console.log(`Created template: ${fileName} with ID: ${uuid}`);
                } else {
                    console.error(`Template file not found: ${sourcePath}`);
                }
            } else {
              //  console.log(`Template file already exists, no action taken: ${targetPath}`);
            }
        }
    }

    async createFolderIfNeeded(folderPath: string) {
        try {
            const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!existingFolder) {
                await this.app.vault.createFolder(folderPath);
                console.log(`Created folder: ${folderPath}`);
            } else {
                console.log(`Folder already exists: ${folderPath}`);
            }
        } catch (error) {
            console.error(`Error creating folder: ${folderPath}`, error);
            new Notice('Error: Could not create folder.');
        }
    }
}
