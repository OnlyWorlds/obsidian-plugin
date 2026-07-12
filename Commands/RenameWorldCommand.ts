import { App, Notice, requestUrl, normalizePath, TFile, TFolder } from 'obsidian';
import { WorldRenameModal } from 'Modals/WorldRenameModal';
import type OnlyWorldsPlugin from '../main';



export class RenameWorldCommand {
    app: App;
    manifest: any;
    plugin: OnlyWorldsPlugin | null;

    constructor(app: App, manifest: any, plugin?: OnlyWorldsPlugin) {
        this.app = app;
        this.manifest = manifest;
        this.plugin = plugin ?? null;
    }

    execute() {
        const modal = new WorldRenameModal(this.app, async (oldWorldName: string, newWorldName: string) => {
            try {
                // Ensures each step completes before starting the next one
                await this.renameWorldFile(oldWorldName, newWorldName);
                await this.renameWorldFolder(oldWorldName, newWorldName);
                await this.checkSettingsFile(oldWorldName, newWorldName);
                new Notice('All changes applied successfully.');
                // Local rename succeeded — push the new name to the API if possible.
                // A failed push must NOT roll back the local rename.
                await this.pushRenameToApi(newWorldName);
            } catch (error) {
                console.error('Error in renaming process:', error);
                new Notice('Failed to complete the renaming process.');
            }
        });
        modal.open();
    }

    // PATCH the world name via the SDK (WorldResource.update → PATCH /world/).
    // Skips silently (local-only) if there's no API key or the user cancels the PIN prompt.
    private async pushRenameToApi(newWorldName: string): Promise<void> {
        if (!this.plugin) {
            new Notice('Rename applied locally only (no API key set).');
            return;
        }

        // The key must be THIS world's — in a multi-world vault the settings key
        // may point at a different world, and /world/ PATCHes whatever world the
        // key resolves to. The renamed world's own World.md is authoritative
        // (folder already renamed by the time this runs); settings is fallback.
        const apiKey = (await this.worldFileApiKey(newWorldName))
            ?? this.plugin.settings.apiKey?.trim();
        if (!apiKey) {
            new Notice('Rename applied locally only (no API key set).');
            return;
        }

        const client = await this.plugin.buildClient(apiKey);
        if (!client) {
            new Notice('Rename applied locally only (PIN not provided).');
            return;
        }

        try {
            await client.worlds.update({ name: newWorldName });
            new Notice('World name updated on onlyworlds.com.');
        } catch (error) {
            console.error('Failed to push world rename to API:', error);
            const msg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Rename saved locally, but API update failed: ${msg}`, 10000);
        }
    }

    // The renamed world's own API key from its World.md, or null.
    private async worldFileApiKey(worldName: string): Promise<string | null> {
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/World.md`);
        const worldFile = this.app.vault.getAbstractFileByPath(worldFilePath);
        if (!(worldFile instanceof TFile)) {
            return null;
        }
        const content = await this.app.vault.read(worldFile);
        const match = content.match(/^- \*\*API Key:\*\* (.+)$/m);
        const key = match?.[1]?.trim();
        return key || null;
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
