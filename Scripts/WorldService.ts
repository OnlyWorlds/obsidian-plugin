import { App, TFolder, TFile, normalizePath } from 'obsidian';
import { Category } from '../enums';

/**
 * Element names are exact on the API and inside notes; FILENAMES are
 * presentation and must be legal. Windows silently mangles a path containing
 * ':' into an NTFS alternate data stream (a note named "Chapter 1: Into the
 * Mists.md" became an extensionless file "Chapter 1" — found on the 2.3.0
 * smoke test), and Obsidian forbids the same set in wikilink targets.
 * Every filename AND every [[wikilink]] target must pass through this;
 * lookups compare sanitized forms so exact names in note bodies still resolve.
 */
export function sanitizeFileName(name: string): string {
    return name
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
        .replace(/[. ]+$/, '')
        .trim() || 'unnamed';
}

export class WorldService {
    private app: App;
    private defaultWorldName: string = 'DefaultWorld'; // Default world name as a fallback
    private folderRenameDebounce: Map<string, NodeJS.Timeout> = new Map();

    constructor(app: App) {
        this.app = app;
    }

    /**
     * The world the user is actually working in: the one owning the ACTIVE note
     * if there is one, else the configured/top-folder world.
     *
     * `getWorldName()` answers "which world is primary", which is the wrong
     * question whenever a note is open — with several worlds in a vault it kept
     * preselecting the top one while the user was editing something else
     * (Captain, 2026-08-22). Any command acting ON a note should call this.
     */
    async getActiveWorldName(): Promise<string> {
        const file = this.app.workspace.getActiveFile();
        const m = file ? /^OnlyWorlds\/Worlds\/([^/]+)\//.exec(file.path) : null;
        if (m) return m[1];
        return this.getWorldName();
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
                // Sort folders to prefer base names over numbered versions
                const sortedFolders = subFolders.sort((a, b) => {
                    // If one has a number suffix and the other doesn't, prefer the one without
                    const aHasNumber = /\s\(\d+\)$/.test(a.name);
                    const bHasNumber = /\s\(\d+\)$/.test(b.name);
                    
                    if (!aHasNumber && bHasNumber) return -1;
                    if (aHasNumber && !bHasNumber) return 1;
                    
                    // Otherwise, sort alphabetically
                    return a.name.localeCompare(b.name);
                });
                
                return sortedFolders[0].name; // Return the name of the first (preferred) folder
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

    async countElementsInCategory(worldName: string, category: string): Promise<number> {
        // Find the category folder by base name (handles both "Character" and "Character (3)" formats)
        const categoryFolder = await this.findCategoryFolderByBaseName(worldName, category);
        
        if (!categoryFolder) {
            return 0;
        }
        
        // Count .md files in the category folder
        const mdFiles = categoryFolder.children.filter(child => 
            child instanceof TFile && child.extension === 'md'
        );
        
        return mdFiles.length;
    }

    async getCategoryFolderNameWithCount(worldName: string, category: string): Promise<string> {
        const count = await this.countElementsInCategory(worldName, category);
        return `${category} (${count})`;
    }

    async getAllCategoryFolderNamesWithCounts(worldName: string): Promise<Record<string, string>> {
        const categoryNames: Record<string, string> = {};
        
        for (const category in Category) {
            if (!isNaN(Number(category))) continue; // Skip numeric enum values
            
            const folderNameWithCount = await this.getCategoryFolderNameWithCount(worldName, category);
            categoryNames[category] = folderNameWithCount;
        }
        
        return categoryNames;
    }

    async findCategoryFolderByBaseName(worldName: string, baseCategoryName: string): Promise<TFolder | null> {
        const elementsPath = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements`);
        const elementsFolder = this.app.vault.getAbstractFileByPath(elementsPath);
        
        if (!(elementsFolder instanceof TFolder)) {
            return null;
        }
        
        for (const child of elementsFolder.children) {
            if (child instanceof TFolder) {
                // Check if folder name starts with the base category name
                if (child.name === baseCategoryName || child.name.startsWith(`${baseCategoryName} (`)) {
                    return child;
                }
            }
        }
        
        return null;
    }

    async updateCategoryFolderName(worldName: string, category: string): Promise<void> {
        const debounceKey = `${worldName}-${category}`;
        
        // Clear any existing debounce timer for this world/category
        if (this.folderRenameDebounce.has(debounceKey)) {
            clearTimeout(this.folderRenameDebounce.get(debounceKey)!);
        }
        
        // Set a new debounce timer
        const timeoutId = setTimeout(async () => {
            try {
                const existingFolder = await this.findCategoryFolderByBaseName(worldName, category);
                
                if (existingFolder) {
                    const newName = await this.getCategoryFolderNameWithCount(worldName, category);
                    
                    // Only rename if the name is different
                    if (existingFolder.name !== newName) {
                        try {
                            const newPath = `${existingFolder.parent?.path}/${newName}`;
                            await this.app.fileManager.renameFile(existingFolder, newPath);
                        } catch (error) {
                            console.error(`Error renaming category folder from ${existingFolder.name} to ${newName}:`, error);
                        }
                    }
                }
            } finally {
                // Remove the debounce timer after completion
                this.folderRenameDebounce.delete(debounceKey);
            }
        }, 300); // 300ms debounce delay
        
        this.folderRenameDebounce.set(debounceKey, timeoutId);
    }

    async updateAllCategoryFolderNames(worldName: string): Promise<void> {
        for (const category in Category) {
            if (!isNaN(Number(category))) continue; // Skip numeric enum values
            
            await this.updateCategoryFolderName(worldName, category);
        }
    }

    async generateUniqueFileName(categoryPath: string, elementName: string, elementId: string): Promise<string> {
        const fs = this.app.vault.adapter;
        const safeName = sanitizeFileName(elementName);

        // First, try the base name
        const baseName = `${safeName}.md`;
        const basePath = normalizePath(`${categoryPath}/${baseName}`);
        
        // Check if file exists with this name
        if (!await fs.exists(basePath)) {
            return baseName; // Use base name if available
        }
        
        // If base name exists, check if it's the same element (by ID)
        try {
            const existingContent = await fs.read(basePath);
            const idMatch = existingContent.match(/^- \*\*ID:\*\* (.+)$/m);
            if (idMatch && idMatch[1].trim() === elementId) {
                return baseName; // Same element, use same filename
            }
        } catch (error) {
            // If can't read existing file, continue with numbering
        }
        
        // Base name exists and is different element, find next available number
        let counter = 1;
        while (true) {
            const numberedName = `${safeName} (${counter}).md`;
            const numberedPath = normalizePath(`${categoryPath}/${numberedName}`);
            
            if (!await fs.exists(numberedPath)) {
                return numberedName; // Found available numbered name
            }
            
            // Check if existing numbered file is the same element
            try {
                const existingContent = await fs.read(numberedPath);
                const idMatch = existingContent.match(/^- \*\*ID:\*\* (.+)$/m);
                if (idMatch && idMatch[1].trim() === elementId) {
                    return numberedName; // Same element, use this filename
                }
            } catch (error) {
                // If can't read, continue to next number
            }
            
            counter++;
            
            // Safety check to prevent infinite loop
            if (counter > 100) {
                return `${safeName} (${Date.now()}).md`;
            }
        }
    }

    /**
     * Find the world folder already holding this API key, if any. The key is the
     * world's IDENTITY; the folder name is just a label the user picked.
     *
     * ⚑ This is the fix for a real duplication bug (2026-08-22): a world created
     * locally as "NewWorld" and then given the key of a differently-named server
     * world downloaded into a SECOND folder, because the key check only ever
     * looked at a folder whose name already matched. Same key = same world,
     * whatever it is called on disk.
     */
    async findWorldFolderByApiKey(worldApiKey: string): Promise<string | null> {
        if (!worldApiKey) return null;
        const worldsFolder = this.app.vault.getAbstractFileByPath(normalizePath('OnlyWorlds/Worlds'));
        if (!(worldsFolder instanceof TFolder)) return null;
        for (const child of worldsFolder.children) {
            if (!(child instanceof TFolder)) continue;
            try {
                const worldFile = this.app.vault.getAbstractFileByPath(
                    normalizePath(`${child.path}/World.md`)
                );
                if (!(worldFile instanceof TFile)) continue;
                const content = await this.app.vault.read(worldFile);
                const match = content.match(/^- \*\*API Key:\*\* (.+)$/m);
                if (match && match[1].trim() === worldApiKey) return child.name;
            } catch {
                // unreadable World.md — skip this folder, keep looking
            }
        }
        return null;
    }

    async generateUniqueWorldName(worldName: string, worldApiKey?: string): Promise<string> {
        const fs = this.app.vault.adapter;
        const worldsBasePath = normalizePath('OnlyWorlds/Worlds');

        // ★ Identity first: if ANY folder already holds this API key, that folder
        // IS this world — reuse it regardless of what it is named on disk.
        if (worldApiKey) {
            const owning = await this.findWorldFolderByApiKey(worldApiKey);
            if (owning) return owning;
        }

        // First, try the base name
        const basePath = normalizePath(`${worldsBasePath}/${worldName}`);

        // Check if folder exists with this name
        if (!await fs.exists(basePath)) {
            return worldName; // Use base name if available
        }
        
        // Base name exists and is different world, find next available number
        let counter = 1;
        while (true) {
            const numberedName = `${worldName} (${counter})`;
            const numberedPath = normalizePath(`${worldsBasePath}/${numberedName}`);
            
            if (!await fs.exists(numberedPath)) {
                return numberedName; // Found available numbered name
            }
            
            // Check if existing numbered folder is the same world
            if (worldApiKey) {
                try {
                    const worldFilePath = normalizePath(`${numberedPath}/World.md`);
                    if (await fs.exists(worldFilePath)) {
                        const existingContent = await fs.read(worldFilePath);
                        const apiKeyMatch = existingContent.match(/^- \*\*API Key:\*\* (.+)$/m);
                        if (apiKeyMatch && apiKeyMatch[1].trim() === worldApiKey) {
                            return numberedName; // Same world, use this name
                        }
                    }
                } catch (error) {
                    // If can't read, continue to next number
                }
            }
            
            counter++;
            
            // Safety check to prevent infinite loop
            if (counter > 100) {
                return `${worldName} (${Date.now()})`;
            }
        }
    }
}
