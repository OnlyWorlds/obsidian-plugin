import { App, TFolder, TFile, normalizePath, FileSystemAdapter } from 'obsidian';
import { Category } from '../enums';

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
    }

    async updateAllCategoryFolderNames(worldName: string): Promise<void> {
        for (const category in Category) {
            if (!isNaN(Number(category))) continue; // Skip numeric enum values
            
            await this.updateCategoryFolderName(worldName, category);
        }
    }

    async generateUniqueFileName(categoryPath: string, elementName: string, elementId: string): Promise<string> {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            return `${elementName}.md`; // Fallback if not file system adapter
        }
        
        const fs: FileSystemAdapter = this.app.vault.adapter;
        
        // First, try the base name
        const baseName = `${elementName}.md`;
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
            const numberedName = `${elementName} (${counter}).md`;
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
                return `${elementName} (${Date.now()}).md`;
            }
        }
    }

    async generateUniqueWorldName(worldName: string, worldApiKey?: string): Promise<string> {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            return worldName; // Fallback if not file system adapter
        }
        
        const fs: FileSystemAdapter = this.app.vault.adapter;
        const worldsBasePath = normalizePath('OnlyWorlds/Worlds');
        
        // First, try the base name
        const basePath = normalizePath(`${worldsBasePath}/${worldName}`);
        
        // Check if folder exists with this name
        if (!await fs.exists(basePath)) {
            return worldName; // Use base name if available
        }
        
        // If base name exists, check if it's the same world (by API key if provided)
        if (worldApiKey) {
            try {
                const worldFilePath = normalizePath(`${basePath}/World.md`);
                if (await fs.exists(worldFilePath)) {
                    const existingContent = await fs.read(worldFilePath);
                    const apiKeyMatch = existingContent.match(/^- \*\*API Key:\*\* (.+)$/m);
                    if (apiKeyMatch && apiKeyMatch[1].trim() === worldApiKey) {
                        return worldName; // Same world, use same name
                    }
                }
            } catch (error) {
                // If can't read existing file, continue with numbering
            }
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
