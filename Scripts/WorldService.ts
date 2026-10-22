import { App, TFolder, TFile, normalizePath } from 'obsidian';
import { Category } from '../enums';
import { safeWorldFolderName } from '../vault/world-name';

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

/** How many `Name (N).md` twins a name gets before the id form takes over. */
export const NUMBERED_TWIN_CAP = 100;

/** True when an element's name gives no file name: empty or whitespace. */
export function isNamelessName(name: unknown): boolean {
    return typeof name !== 'string' || name.trim() === '';
}

/**
 * The id's mark in a file name: its last 8 hex characters, the uuid tail the
 * folder spec's §3.2 uses for the same job. Not the first 8: a uuidv7 starts
 * with its millisecond clock, so elements made in the same minute share it
 * (Moppetopia's 131 nameless Markers have 10 distinct first-8 prefixes and 131
 * distinct tails).
 */
export function idMark(elementId: string): string {
    const hex = String(elementId).replace(/[^0-9a-zA-Z]/g, '');
    return (hex.length >= 8 ? hex.slice(-8) : hex).toLowerCase();
}

/** The element type a category folder names: `Marker (131)` is Marker. */
export function categoryOfFolder(categoryPath: string): string {
    const leaf = categoryPath.replace(/\/+$/, '').split('/').pop() ?? '';
    return leaf.replace(/ \(\d+\)$/, '');
}

/**
 * The note names an element may carry, first choice first, never the clock:
 *   - a name: `Name`, then `Name (1)` to `Name (100)`, then `Name <id tail>`,
 *     then `Name <full id>`;
 *   - no name: `<Type> <id tail>`, then `<Type> <full id>`.
 * The same element gets the same name on every download (the id decides it).
 */
export function noteNameCandidates(elementName: unknown, elementId: string, type: string): string[] {
    const id = String(elementId);
    if (isNamelessName(elementName)) {
        const typeName = sanitizeFileName(type || 'Element');
        return [`${typeName} ${idMark(id)}`, `${typeName} ${sanitizeFileName(id)}`];
    }
    const safeName = sanitizeFileName(String(elementName));
    const out = [safeName];
    for (let n = 1; n <= NUMBERED_TWIN_CAP; n++) out.push(`${safeName} (${n})`);
    out.push(`${safeName} ${idMark(id)}`, `${safeName} ${sanitizeFileName(id)}`);
    return out;
}

/**
 * True when `basename` is one of the names this element may carry, so a
 * re-download keeps the note where it is. A name's twins `Name (N)` stay
 * accepted at any N (a vault from before the cap).
 */
export function isNoteNameFor(basename: string, elementName: unknown, elementId: string, type: string): boolean {
    const id = String(elementId);
    if (isNamelessName(elementName)) {
        return noteNameCandidates(elementName, id, type).includes(basename);
    }
    const safeName = sanitizeFileName(String(elementName));
    if (basename === safeName) return true;
    if (basename.startsWith(`${safeName} (`) && /^ \(\d+\)$/.test(basename.slice(safeName.length))) return true;
    return basename === `${safeName} ${idMark(id)}` || basename === `${safeName} ${sanitizeFileName(id)}`;
}

/** The element id a note's text carries: frontmatter `id:`, else the legacy bold line. */
function noteIdInText(content: string): string | null {
    const fm = /^id:[ \t]*["']?([^\s"']+)/m.exec(content.replace(/^\s+/, ''));
    if (fm) return fm[1];
    const legacy = /^- \*\*ID:\*\* (.+)$/m.exec(content);
    return legacy ? legacy[1].trim() : null;
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

    /**
     * `taken` (lowercased paths) holds names a caller has already handed to
     * OTHER elements but not yet written — Download plans a whole pull before
     * writing, so two same-name elements in one pull get `Twin.md` and
     * `Twin (1).md` instead of both planning `Twin.md` (OW Infra #166 row 2).
     */
    /**
     * The note file name for an element, from noteNameCandidates: the first
     * name that is free, or that already holds this element (its id read from
     * the file, frontmatter or legacy line). A nameless element is
     * `<Type> <id tail>.md` (the type from the category folder), and a name
     * past its 100 numbered twins is `Name <id tail>.md`: never the clock, so
     * two elements never share a file and a re-download finds the same one.
     */
    async generateUniqueFileName(categoryPath: string, elementName: string, elementId: string, taken?: Set<string>): Promise<string> {
        const fs = this.app.vault.adapter;
        const isTaken = (path: string) => taken?.has(path.toLowerCase()) ?? false;
        const candidates = noteNameCandidates(elementName, elementId, categoryOfFolder(categoryPath));

        for (const base of candidates) {
            const fileName = `${base}.md`;
            const path = normalizePath(`${categoryPath}/${fileName}`);
            if (isTaken(path)) continue;
            if (!await fs.exists(path)) return fileName;
            try {
                if (noteIdInText(await fs.read(path)) === elementId) return fileName; // this element's own note
            } catch {
                // unreadable: someone else's, try the next name
            }
        }

        // Every candidate held by another note (the full id form included,
        // which only a hand-made note could take): number the full id form.
        const last = candidates[candidates.length - 1];
        for (let n = 1; ; n++) {
            const fileName = `${last} (${n}).md`;
            const path = normalizePath(`${categoryPath}/${fileName}`);
            if (!isTaken(path) && !await fs.exists(path)) return fileName;
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

    async generateUniqueWorldName(rawWorldName: string, worldApiKey?: string): Promise<string> {
        // A server's or a link's name is never a path: one safe segment
        // (Kael's review 3.7).
        const worldName = safeWorldFolderName(rawWorldName);
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
