import { App, TFolder, TFile, normalizePath } from 'obsidian';

export class WorldService {
    private app: App;
    private defaultWorldName: string = 'DefaultWorld'; // Default world name as a fallback

    constructor(app: App) {
        this.app = app;
    }

    async getWorldName(): Promise<string> { 
        const settingsWorldName = await this.getWorldNameFromSettings();
        if (settingsWorldName && await this.verifyWorldExists(settingsWorldName)) { 
            return settingsWorldName;
        } else {
         //   No valid world name in settings or no matching folder, use top folder 
            return this.getWorldNameFromTopFolder();
        }
    }

    private async getWorldNameFromSettings(): Promise<string | null> {
        const settingsPath = normalizePath('OnlyWorlds/Settings.md');
        try {
            const settingsFile = this.app.vault.getAbstractFileByPath(settingsPath);

            if (!(settingsFile instanceof TFile)) {
                console.error('Expected settings file not found.');
                return "";  
}
            const content = await this.app.vault.read(settingsFile);
            const match = content.match(/^- \*\*Primary World Name:\*\* (.+)$/m);
            if (match && match[1].trim()) {
                return match[1].trim();
            }
        } catch (error) {
         
        }
        return null; // Return null if settings file is not found or no name is specified
    }

    async getDefaultEmailFromSettings(): Promise<string | null> {
        const settingsPath = normalizePath('OnlyWorlds/Settings.md');
        try {
            const settingsFile = this.app.vault.getAbstractFileByPath(settingsPath);

            if (!(settingsFile instanceof TFile)) {
                return null;  
            }
            const content = await this.app.vault.read(settingsFile);
            const match = content.match(/^- \*\*Default Email Address:\*\* (.+)$/m);
            if (match && match[1].trim()) {
                const email = match[1].trim();
                // Basic email validation
                if (this.isValidEmail(email)) {
                    return email;
                }
            }
        } catch (error) {
         
        }
        return null;
    }

    private isValidEmail(email: string): boolean {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    private async getWorldNameFromTopFolder(): Promise<string> {
        const worldsPath = normalizePath('OnlyWorlds/Worlds');
        const worldsFolder = this.app.vault.getAbstractFileByPath(worldsPath);
        if (worldsFolder instanceof TFolder && worldsFolder.children.length > 0) {
            const subFolders = worldsFolder.children.filter(child => child instanceof TFolder);
            if (subFolders.length > 0) {
                const worldFolder = subFolders[0];
                return worldFolder.name; // Return the name of the first subfolder
            }
        }
        return this.defaultWorldName; // Return default world name if no subfolder is found
    }

    private async verifyWorldExists(worldName: string): Promise<boolean> {
        const worldsPath = normalizePath('OnlyWorlds/Worlds');
        const worldsFolder = this.app.vault.getAbstractFileByPath(worldsPath);
        if (worldsFolder instanceof TFolder) {
            const exists = worldsFolder.children.some(child => child instanceof TFolder && child.name === worldName);
            return exists;
        }
        return false;
    }
}
