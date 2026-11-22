import { App, PluginManifest, Notice, normalizePath } from 'obsidian';

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

        // A README that is already in the vault is the person's: never fetched for, never replaced
        // (an edited one survives Create world, Download world and Paste world). Nothing goes
        // out to GitHub unless the note is missing.
        if (this.app.vault.getAbstractFileByPath(readmePath)) return;

        try {
            // Fetch the README from GitHub
            const response = await fetch(githubReadmeUrl);
            if (!response.ok) {
                throw new Error(`Could not fetch the README from GitHub: ${response.statusText}`);
            }

            const content = await response.text();

            // Another command may have made the note while the fetch was out: keep what is there.
            if (this.app.vault.getAbstractFileByPath(readmePath)) return;
            await this.app.vault.create(readmePath, content);
        } catch (error) {
            console.error('Failed to fetch the README:', error);
            new Notice('Could not fetch the README.');
        }
    }
}
