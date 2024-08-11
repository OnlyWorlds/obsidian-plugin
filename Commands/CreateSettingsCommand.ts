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


*Specify the name of the world you are working on here. Affects element creation commands, copy world command, and manual validation command.  
When empty, defaults to first in the hierarchy under OnlyWorlds/Worlds/*
- **Primary World Name:** 

*Change to 'Yes', then reload Obsidian, to include a separate creation command for each element category. 
('Create new Character', 'Create new Location', etc)*
- **Individual Element Creation Commands:** No

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
