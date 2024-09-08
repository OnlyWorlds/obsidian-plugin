import { App, Notice, requestUrl, FileSystemAdapter, normalizePath, TFile, TFolder } from 'obsidian';
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
        const worldFile = this.app.vault.getAbstractFileByPath(worldFilePath);

        if (worldFile instanceof TFile) {
            const worldFileContent = await this.app.vault.read(worldFile);
            const updatedContent = this.updateWorldNameInContent(worldFileContent, newWorldName);
            await this.app.vault.modify(worldFile, updatedContent);
            new Notice('World file name updated successfully.');
        } else {
            new Notice('World file does not exist.');
        }
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
        const oldPath = normalizePath(`OnlyWorlds/Worlds/${oldWorldName}`);
        const newPath = normalizePath(`OnlyWorlds/Worlds/${newWorldName}`);
        const oldFolder = this.app.vault.getAbstractFileByPath(oldPath) as TFolder | null;
    
        if (oldFolder instanceof TFolder) {
            // Correctly using renameFolder through the FileManager
            await this.app.fileManager.renameFile(oldFolder, newPath);
            new Notice(`World folder renamed successfully from '${oldWorldName}' to '${newWorldName}'.`);
        } else {
            new Notice('World folder does not exist.');
        }
    }

    async checkSettingsFile(oldWorldName: string, newWorldName: string) {
        const settingsFilePath = normalizePath('OnlyWorlds/Settings.md');
        const settingsFile = this.app.vault.getAbstractFileByPath(settingsFilePath);

        if (settingsFile instanceof TFile) {
            const content = await this.app.vault.read(settingsFile);
            const updatedContent = this.updateWorldNameInSettings(content, oldWorldName, newWorldName);
            await this.app.vault.modify(settingsFile, updatedContent);
            new Notice('Settings file updated successfully.');
        } else {
            new Notice('Settings file does not exist.');
        }
    }

    updateWorldNameInSettings(content: string, oldWorldName: string, newWorldName: string): string {
        const regex = new RegExp(`^- \\*\\*Primary World Name:\\*\\*\\s+${oldWorldName.trim()}$`, 'm');
        return content.replace(regex, `- **Primary World Name:** ${newWorldName}`);
    }
}
