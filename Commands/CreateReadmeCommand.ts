import { App, PluginManifest, Notice, normalizePath, TFile } from 'obsidian';

export class CreateReadmeCommand {
    private app: App;
    private manifest: PluginManifest;

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute(): Promise<void> {
        const readmePath = normalizePath('OnlyWorlds/README.md');
        const githubReadmeUrl = 'https://raw.githubusercontent.com/OnlyWorlds/obsidian-plugin/main/README.md';  // URL to fetch the README

        try {
            // Fetch the README from GitHub
            const response = await fetch(githubReadmeUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch README from GitHub: ${response.statusText}`);
            }
            new Notice('Fetching necessary files..');
            
            const content = await response.text();

            // Check if the README already exists in the user's vault
            const existingFile = this.app.vault.getAbstractFileByPath(readmePath);
            if (!existingFile) {
                // Create the README if it doesn't exist
                await this.app.vault.create(readmePath, content); 
            } else if (existingFile instanceof TFile) {
                // Update the existing README if it already exists
                await this.app.vault.modify(existingFile, content); 
            } else {
                console.error('The README file was not found or is not a file.');
            }
        } catch (error) {
            console.error('Failed to fetch or update README:', error);
            new Notice('Error: Could not fetch or update README.');
        }
    }
}
