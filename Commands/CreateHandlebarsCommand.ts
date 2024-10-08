import { App, Notice, normalizePath } from 'obsidian';
import { Category } from '../enums';

export class CreateHandlebarsCommand {
    app: App;
    manifest: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute(): Promise<void> {
        const handlebarsFolder = normalizePath('OnlyWorlds/Handlebars');
        const categories = Object.keys(Category).filter(key => isNaN(Number(key)));

        // Ensure the Handlebars folder exists
        await this.createFolderIfNeeded(handlebarsFolder);

        // Base URL for fetching the Handlebars templates from GitHub
        const githubBaseUrl = 'https://raw.githubusercontent.com/OnlyWorlds/OnlyWorlds/main/languages/obsidian_handlebars/';

        console.log('Fetching Handlebars templates from GitHub');
        for (const category of categories) {
            const fileName = `${category}Handlebar.md`; // Example: CharacterHandlebar.md
            const targetPath = normalizePath(`${handlebarsFolder}/${fileName}`);
            const templateUrl = `${githubBaseUrl}${fileName}`;

            // Check if the Handlebars template file already exists in the user's vault
            if (!this.app.vault.getAbstractFileByPath(targetPath)) {
                try {
                    // Fetch the Handlebars template from GitHub
                    const response = await fetch(templateUrl);
                    if (!response.ok) {
                        throw new Error(`Failed to fetch template: ${templateUrl}`);
                    }
                    let content = await response.text();

                    // Write the content to the user's vault in the Handlebars folder
                    await this.app.vault.create(targetPath, content);
                    console.log(`Handlebars template ${fileName} created successfully.`);
                } catch (error) {
                    console.error(`Error fetching Handlebars template for ${category}:`, error);
                    new Notice(`Error fetching Handlebars template for ${category}.`);
                }
            } else {
                console.log(`Handlebars template ${fileName} already exists, skipping.`);
            }
        }
    }

    // Function to create the folder if it doesn't exist
    async createFolderIfNeeded(folderPath: string) {
        try {
            const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!existingFolder) {
                await this.app.vault.createFolder(folderPath);
            }
        } catch (error) {
            console.error(`Error creating folder: ${folderPath}`, error);
            new Notice('Error: Could not create folder.');
        }
    }
}
