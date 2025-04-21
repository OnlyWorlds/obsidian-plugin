import { App, Notice, normalizePath } from 'obsidian';
import { v7 as uuidv7 } from 'uuid';
import { Category } from '../enums';

export class CreateTemplatesCommand {
    app: App;
    manifest: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute(): Promise<void> {
        const templateFolder = normalizePath('OnlyWorlds/PluginFiles/Templates');
        const categories = Object.keys(Category).filter(key => isNaN(Number(key)));

        // Ensure the template folder exists
        await this.createFolderIfNeeded(templateFolder);

        // Base URL for fetching the templates from GitHub
        const githubBaseUrl = 'https://raw.githubusercontent.com/OnlyWorlds/OnlyWorlds/main/conversions/obsidian_templates/';
     

        for (const category of categories) {
            const fileName = `${category}.md`;
            const targetPath = normalizePath(`${templateFolder}/${fileName}`);
            const templateUrl = `${githubBaseUrl}${fileName}`;

            // Check if the template file already exists in the user's vault
            if (!this.app.vault.getAbstractFileByPath(targetPath)) {
                try {
                    // Fetch the template from GitHub
                    const response = await fetch(templateUrl);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch template: ${templateUrl}`);
                    }
                    let content = await response.text();

                    // Replace {{id}} placeholder with a UUID, if needed
                    const uuid = uuidv7();
                    content = content.replace('{{id}}', uuid);

                    // Write the content to the user's vault
                    await this.app.vault.create(targetPath, content);
                    console.log(`Template ${fileName} created successfully.`);
                } catch (error) {
                    console.error(`Error fetching template for ${category}:`, error);
                    new Notice(`Error fetching template for ${category}.`);
                }
            } else {
                console.log(`Template ${fileName} already exists, skipping.`);
            }
        }
    }

    async createFolderIfNeeded(folderPath: string) {
        try {
            const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!existingFolder) {
                await this.app.vault.createFolder(folderPath);
                new Notice('Fetching Plugin Files..');
            }
        } catch (error) {
            console.error(`Error creating folder: ${folderPath}`, error);
            new Notice('Error: Could not create folder.');
        }
    }
}
