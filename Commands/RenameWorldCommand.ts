import { App, Notice, requestUrl, FileSystemAdapter, normalizePath } from 'obsidian';
import { WorldRenameModal } from 'Modals/WorldRenameModal';

export class RenameWorldCommand {
    app: App;
    manifest: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }

    execute() {
        const modal = new WorldRenameModal(this.app, async (oldWorldName: string, newWorldName: string) => {
            try {
                // Ensures each step completes before starting the next one
                await this.renameWorldFile(oldWorldName, newWorldName);
                await this.renameWorldFolder(oldWorldName, newWorldName);
                await this.checkSettingsFile(oldWorldName, newWorldName);
                new Notice('All changes applied successfully.');
            } catch (error) {
                console.error('Error in renaming process:', error);
                new Notice('Failed to complete the renaming process.');
            }
        });
        modal.open();
    }

     async renameWorldFile(oldWorldName: string, newWorldName: string) {
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${oldWorldName}/World.md`);
        const fs: FileSystemAdapter = this.app.vault.adapter as FileSystemAdapter;
        const worldFileContent = await fs.read(worldFilePath);
        const updatedContent = this.updateWorldNameInContent(worldFileContent, newWorldName);
        await fs.write(worldFilePath, updatedContent);
        new Notice('World file name updated successfully.');
    }

    private updateWorldNameInContent(content: string, newName: string): string {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('- **Name:**')) {
                lines[i] = `- **Name:** ${newName}`;
                break;
            }
        }
        return lines.join('\n');
    }
     async renameWorldFolder(oldWorldName: string, newWorldName: string) {
        const fs: FileSystemAdapter = this.app.vault.adapter as FileSystemAdapter;
        const oldPath = `OnlyWorlds/Worlds/${oldWorldName}`;
        const newPath = `OnlyWorlds/Worlds/${newWorldName}`;
        await fs.rename(oldPath, newPath);
        new Notice(`World folder renamed successfully from '${oldWorldName}' to '${newWorldName}'.`);
    }

  
    checkSettingsFile(oldWorldName: string, newWorldName: string) {
        const settingsFilePath = normalizePath('OnlyWorlds/Settings.md');

        this.app.vault.adapter.read(settingsFilePath).then(content => {
            const updatedContent = this.updateWorldNameInSettings(content, oldWorldName, newWorldName); 
            this.app.vault.adapter.write(settingsFilePath, updatedContent).then(() => {
                new Notice('Settings file updated successfully.');
            }).catch(error => {
                console.error('Failed to update settings file:', error);
                new Notice('Failed to update settings file.');
            });
        }).catch(error => {
            console.error('Failed to read settings file:', error);
            new Notice('Failed to read settings file.');
        });
    }

    updateWorldNameInSettings(content: string, oldWorldName: string, newWorldName: string): string {
        // Regex to match the line with the world name, accounting for potential variations in whitespace
        const regex = new RegExp(`^- \\*\\*Primary World Name:\\*\\*\\s+${oldWorldName.trim()}$`, 'm');
        return content.replace(regex, `- **Primary World Name:** ${newWorldName}`);
    }
}
