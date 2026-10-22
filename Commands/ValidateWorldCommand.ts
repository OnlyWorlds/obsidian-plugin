import { ValidateResultModal } from '../Modals/ValidateResultModal';
import { App, normalizePath, PluginManifest, TAbstractFile, TFile, TFolder } from 'obsidian';
import { WorldService, sanitizeFileName } from '../Scripts/WorldService';
import { parseRawFrontmatterScalars } from '../vault/element-transform';
import { Category } from '../enums'; // Ensure this import is correct

export class ValidateWorldCommand {
    app: App;
    manifest: PluginManifest;
    worldService: WorldService;
    manualTrigger: boolean;

    // Declaring error lists
    errors = {
        numberErrors: [] as string[],
        maxNumberErrors: [] as string[],
        singleLinkFieldErrors: [] as string[],
        multiLinkFieldErrors: [] as string[],
        missingIdErrors: [] as string[],
        nameMismatchErrors: [] as string[],
        worldFileErrors: [] as string[]
    };

    elementCount: number = 0;
    checkedCount: number = 0;
    errorCount: number = 0;

    /** The frontmatter checks: `id` present and UUID-shaped; `name` matching the
     *  file (the name as the writer files it, a numbered twin allowed). */
    validateFrontmatterElement(category: string, fileName: string, content: string) {
        this.checkedCount++;
        const displayName = fileName.replace(/\.md$/, '');
        const fm = parseRawFrontmatterScalars(content, ['id', 'name']);
        const id = (fm.id ?? '').trim().replace(/^["']|["']$/g, '');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
            this.errorCount++;
            this.errors.missingIdErrors.push(`(${category}) ${displayName} has error in Id: ${id ? 'not a UUID' : 'field is empty'}`);
        }
        const name = (fm.name ?? '').trim().replace(/^["']|["']$/g, '');
        const filed = sanitizeFileName(name);
        if (!name || (displayName !== filed && !displayName.startsWith(`${filed} (`))) {
            this.errorCount++;
            this.errors.nameMismatchErrors.push(`(${category}) ${displayName} has error in Name: field does not match file name`);
        }
    }

     constructor(app: App, manifest: PluginManifest, worldService: WorldService, manualTrigger: boolean = true) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
        this.manualTrigger = manualTrigger;
    }
    async execute(worldFolderName?: string) {
        console.log("Starting world validation...");
        this.resetErrors(); // Reset errors before starting validation
        
        if (!worldFolderName) {
            worldFolderName = await this.worldService.getWorldName();
        }
        
        const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${worldFolderName}/Elements`);

        const elementsFolder = this.app.vault.getAbstractFileByPath(worldFolderPath);
        
        if (!(elementsFolder instanceof TFolder)) {
            console.error('Elements folder not found.');
            return;  
        }
     
        
        for (const categoryKey in Category) {
            const category = Category[categoryKey];
            if (!isNaN(Number(category))) continue; // Skip if category is not a string

            // A type's folder is `Location`, or `Location (2)` in a vault from
            // 3.8.1 or earlier that no Download has renamed yet, or both: every one is
            // read (an exact path once skipped every counted folder and
            // validated nothing: Seethe, h57 #4846, 3.3.1).
            const categoryFolders = await this.worldService.findCategoryFolders(worldFolderName, category);

            const files = ([] as TAbstractFile[]).concat(...categoryFolders.map((folder) => folder.children));
            for (const file of files) {
                if (file instanceof TFile && file.extension === 'md') {
                    this.elementCount++;
                    const content = await this.app.vault.read(file);
                    this.validateElement(category, file.name, content);
                }
            }
        }
        
        console.log(`Validation complete. Notes found: ${this.elementCount}, checked: ${this.checkedCount}, errors: ${this.errorCount}`);

        if (this.manualTrigger) {
            new ValidateResultModal(this.app, this.errors, this.elementCount, this.errorCount, worldFolderName, this.checkedCount).open();
        }
    }
    
   

    validateWorldFile(content: string): boolean {
        const idMatch = content.match(/Id:\s*(\S+)/);
        const nameMatch = content.match(/Name:\s*(\S+)/);
        if (!idMatch || !nameMatch) {
            this.errorCount++;
            this.errors.worldFileErrors.push(`World file format error: Id and Name must each have a value`);
            return false;
        }
        return true;
    }
    
    validateElement(category: string, fileName: string, content: string) {
        // A frontmatter note (every note the plugin writes since 3.0.0) gets the
        // two checks that hold in that format: an id, and a name that matches the
        // file. Number and link rules below read the legacy <span> format only.
        // Until 3.3.2 these notes were skipped and still counted, so "No issues"
        // was said over a world nobody had checked (Seethe, h57 #4864).
        if (content.startsWith('---')) {
            this.validateFrontmatterElement(category, fileName, content);
            return;
        }
        this.checkedCount++;

        let idFound = false;
        let nameFound = false;
        const lines = content.split('\n');
        const displayName = fileName.replace('.md', '');
    
        lines.forEach(line => {
            if (!line.trim()) return;  // Skip empty or whitespace-only lines
    
            if (line.includes('number-field')) {
                const numberPart = line.split(':').pop();
                const fieldName = line.match(/data-tooltip="[^"]*">([^<]+)<\/span>/)?.[1]?.trim() || 'Unknown field';
                if (numberPart && numberPart.trim()) {
                    // Extracting the number from the content
                    const numberMatch = numberPart.trim().match(/^(\d+)$/);
                    if (numberMatch) {
                        const number = parseInt(numberMatch[1], 10);
                        // Check if there's a max value specified in the field
                        const maxMatch = line.match(/max:\s*(\d+)/);
                        if (maxMatch) {
                            const max = parseInt(maxMatch[1], 10);
                            if (number > max) {
                                this.errorCount++;
                                this.errors.maxNumberErrors.push(`(${category}) ${displayName} has error in ${fieldName}: max value exceeded`);
                            }
                        }
                    } else {
                        this.errorCount++;
                        this.errors.numberErrors.push(`(${category}) ${displayName} has error in ${fieldName}: Invalid or missing number`);
                    }
                }
            }
            if (line.includes('"link-field')) {
                const parts = line.split(':');
                const contentAfterColon = parts.length > 1 ? parts[1].trim() : '';
                const fieldName = line.match(/data-tooltip="[^"]*">([^<]+)<\/span>/)?.[1]?.trim() || 'Unknown field';
                if (contentAfterColon) {
                    // Check if content matches exactly one link format and nothing else
                    const validLinkFormat = /^\s*\[\[[^\]]+\]\]\s*$/;
                    if (validLinkFormat.test(contentAfterColon)) {
                        // Valid single link field
                    } else {
                        this.errorCount++;
                        this.errors.singleLinkFieldErrors.push(`(${category}) ${displayName} has error in ${fieldName}: Invalid link format`);
                    }
                }
            }
            
            if (line.includes('multi-link-field')) {
                const parts = line.split(':');
                const contentAfterColon = parts.length > 1 ? parts[1].trim() : '';
                const fieldName = line.match(/data-tooltip="[^"]*">([^<]+)<\/span>/)?.[1]?.trim() || 'Unknown field';
                if (contentAfterColon) {
                    // Check if content follows one of these valid formats:
                    // 1. Comma-separated links: [[Link1]],[[Link2]],[[Link3]]
                    // 2. Single link: [[Link1]]
                    const validMultiLinkFormatCSV = /^\s*(\[\[[^\]]+\]\]\s*,\s*)*\[\[[^\]]+\]\]\s*$/;
                    const validSingleLinkFormat = /^\s*\[\[[^\]]+\]\]\s*$/;
                    
                    if (validMultiLinkFormatCSV.test(contentAfterColon) || validSingleLinkFormat.test(contentAfterColon)) {
                        // Valid multi-link field
                    } else {
                        this.errorCount++;
                        this.errors.multiLinkFieldErrors.push(`(${category}) ${displayName} has error in ${fieldName}: Invalid format`);
                    }
                }
            }
    
            // Validation for ID field being non-empty
            if (line.includes('<span class="text-field" data-tooltip="Text">Id</span>:')) {
                const parts = line.split(':');
                const idValue = parts.length > 1 ? parts[1].trim() : '';
                if (!idValue) {
                    this.errorCount++;
                    this.errors.missingIdErrors.push(`(${category}) ${displayName} has error in Id: field is empty`);
                } else {
                    idFound = true;
                }
            }
    
            // Validation for Name field matching the file name
            if (line.includes('<span class="text-field" data-tooltip="Text">Name</span>:')) {
                const parts = line.split(':');
                const nameValue = parts.length > 1 ? parts[1].trim().replace(/["']/g, "") : ''; // Removing potential quotation marks
                if (!nameValue || nameValue !== displayName) {
                    this.errorCount++;
                    this.errors.nameMismatchErrors.push(`(${category}) ${displayName} has error in Name: field does not match file name`);
                } else {
                    nameFound = true;
                }
            }
        });
    }
    
    resetErrors() {
        this.errors = {
            numberErrors: [] as string[],
            maxNumberErrors: [] as string[],
            singleLinkFieldErrors: [] as string[],
            multiLinkFieldErrors: [] as string[],
            missingIdErrors: [] as string[],
            nameMismatchErrors: [] as string[],
            worldFileErrors: [] as string[]
        };
        this.elementCount = 0;
        this.checkedCount = 0;  // one command object lives the whole session (main.ts); Seethe saw 2, 4, 6, 8
        this.errorCount = 0;
    }
    
}

