import { App, Notice, requestUrl, normalizePath, TFile, TFolder } from 'obsidian';
import { WorldRenameModal } from '../Modals/WorldRenameModal';
import { READ_ONLY_WORLD_MESSAGE, resolveWorldKey, splitWorldsByWrite } from '../vault/world-key';
import { safeWorldFolderName } from '../vault/world-name';
import { moveWorldBasesFileAfterRename } from '../vault/bases-writer';
import { WorldService } from '../Scripts/WorldService';
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

    async execute() {
        const modal = new WorldRenameModal(this.app, async (oldWorldName: string, newWorldName: string) => {
            try {
                // Ensures each step completes before starting the next one
                // The folder is the new name's one safe path segment (Kael's
                // review 3.7); World.md and the server get the name as typed.
                const newFolder = safeWorldFolderName(newWorldName);
                await this.renameWorldFile(oldWorldName, newWorldName);
                await this.renameWorldFolder(oldWorldName, newFolder);
                await this.checkSettingsFile(oldWorldName, newFolder);
                // Push to the API BEFORE claiming success — the notice must
                // reflect what actually happened on onlyworlds.com, not just the
                // local rename (the false-success class, 2026-07-12).
                await this.pushRenameToApi(newWorldName, newFolder);
            } catch (error) {
                console.error('Error in renaming process:', error);
                new Notice('Failed to complete the renaming process.');
            }
        });
        // A read key (ow_r_) can never rename the world on onlyworlds.com:
        // such worlds are not offered, and a vault whose every world is
        // read-only is refused before the dialog opens, with nothing renamed
        // and nothing sent (Seethe's walk of rc-next, h37 #6462).
        const { writable, readOnly } = await splitWorldsByWrite(this.app, this.plugin?.settings.apiKey);
        if (writable.length === 0 && readOnly.length > 0) {
            new Notice(READ_ONLY_WORLD_MESSAGE, 8000);
            return;
        }
        modal.worlds = writable;
        modal.readOnlyLeftOut = readOnly.length > 0;
        modal.open();
    }

    // PATCH the world name via the SDK (WorldResource.update → PATCH /world/),
    // using THIS world's own key. A local-only rename is stated plainly, never
    // dressed up as a synced success.
    private async pushRenameToApi(newWorldName: string, newFolder: string): Promise<void> {
        if (!this.plugin) {
            new Notice('World renamed in your vault (not synced: no plugin context).');
            return;
        }

        // World.md key wins; settings is fallback ONLY when the world has no key
        // of its own. Never silently write to whatever world the settings key
        // names (the wrong-world class).
        const resolved = await resolveWorldKey(this.app, newFolder, this.plugin.settings.apiKey);
        if (resolved.source === 'local-world') {
            new Notice('World renamed in your vault (local-only world — nothing to update on onlyworlds.com).');
            return;
        }
        if (resolved.readOnly) {
            new Notice('World renamed in your vault. Not synced: this world is read-only in this vault (an ow_r_ key).');
            return;
        }
        if (!resolved.apiKey) {
            new Notice('World renamed in your vault. Not synced: no API key for this world.');
            return;
        }

        const client = await this.plugin.buildClient(resolved.apiKey);
        if (!client) {
            new Notice('World renamed in your vault. Not synced: PIN not provided.');
            return;
        }

        try {
            await client.worlds.update({ name: newWorldName });
            new Notice(`World renamed on onlyworlds.com${resolved.ownWorld ? '' : ' (using your default key)'}.`);
        } catch (error) {
            console.error('Failed to push world rename to API:', error);
            const msg = error instanceof Error ? error.message : 'Unknown error';
            // Read-only key or any write failure: say so, do NOT claim success.
            new Notice(`World renamed in your vault, but onlyworlds.com was not updated: ${msg}`, 12000);
        }
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
            // The once-only Notice list names world folders: the old name no
            // longer names this world, or any (round C, 12).
            const noticed = this.plugin?.settings.basesKeptNoticed ?? [];
            if (this.plugin && oldWorldName !== newWorldName && noticed.includes(oldWorldName)) {
                this.plugin.settings.basesKeptNoticed = noticed.filter((w) => w !== oldWorldName);
                await this.plugin.saveSettings();
            }
            // The renames auto-sync left for Save Element are kept by world
            // folder: they move with it (Kael's fixes read, low 5).
            const pending = this.plugin?.settings.pendingRenames ?? {};
            if (this.plugin && oldWorldName !== newWorldName && pending[oldWorldName]) {
                const { [oldWorldName]: moved, ...rest } = pending;
                this.plugin.settings.pendingRenames = { ...rest, [newWorldName]: [...(rest[newWorldName] ?? []), ...moved] };
                await this.plugin.saveSettings();
            }
            // The world's Bases file moved with the folder, but its filters still
            // name the old one (OW Infra #188): rewrite the plugin's own file.
            await moveWorldBasesFileAfterRename(this.app, oldWorldName, newWorldName, this.plugin ?? undefined);
            // Each type folder's count, `Character (4)`, counted again under
            // the new name: a recount queued for the old name finds no folder
            // once it has moved (round C, 12).
            await new WorldService(this.app).updateAllCategoryFolderNames(newWorldName);
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
