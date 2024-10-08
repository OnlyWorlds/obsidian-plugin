import { App, Notice, PluginManifest, TFile, normalizePath } from 'obsidian';

export class CreateSettingsCommand {
    private app: App;
    private manifest: PluginManifest;

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute(): Promise<void> {
        const settingsPath = normalizePath('OnlyWorlds/Settings.md');
        const fileExists = await this.app.vault.adapter.exists(settingsPath);

        if (!fileExists) {
            const content = `# OnlyWorlds Plugin Settings

- **Primary World Name:** 
*Specify the name of the world you are actively working on.
Affects: 1. element creation commands, 2. copy world command, 3. manual validation command.
When empty, defaults to top-in-hierarchy under OnlyWorlds/Worlds/*

- **Individual Element Creation Commands:** No
*Change to 'Yes' to allow a separate creation command for each element category.
('Create new Character', 'Create new Location', etc)
Reload Obsidian to register change.*


- **Default New Element Category:** Character
*Determines which category is pre-filled when the Create Element command is executed.
Reload Obsidian to register change.*
`;

            await this.app.vault.create(settingsPath, content);
        //    new Notice('Settings note created successfully.');
        } else {
           // new Notice('Settings note already exists.');
            // Optionally, open the note for the user
            const file = this.app.vault.getAbstractFileByPath(settingsPath);
            if (file instanceof TFile) {
                this.app.workspace.openLinkText(file.basename, file.path, false);
            }
        }
    }
}
