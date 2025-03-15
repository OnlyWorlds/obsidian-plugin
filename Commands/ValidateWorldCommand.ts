import { ValidateResultModal } from 'Modals/ValidateResultModal'; // Ensure path is correct
import { App, normalizePath, PluginManifest, TFile, TFolder } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
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
    errorCount: number = 0;

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
        
            const categoryPath = normalizePath(`${worldFolderPath}/${category}`);
            const categoryFolder = this.app.vault.getAbstractFileByPath(categoryPath);
        
            if (!(categoryFolder instanceof TFolder)) {
                continue; // Skip to the next category if the folder is not found
            }
         
            for (const file of categoryFolder.children) {
                if (file instanceof TFile) {
                    this.elementCount++;
                    const content = await this.app.vault.read(file);
                    this.validateElement(category, file.name, content);
                }
            }
        }
        
        console.log(`Validation complete. Total elements scanned: ${this.elementCount}, Errors found: ${this.errorCount}`);
      
        if (this.manualTrigger) {
            new ValidateResultModal(this.app, this.errors, this.elementCount, this.errorCount, worldFolderName).open();
        }
    }
    
   

    validateWorldFile(content: string): boolean {
        const idMatch = content.match(/Id:\s*(\S+)/);
        const nameMatch = content.match(/Name:\s*(\S+)/);
        if (!idMatch || !nameMatch) {
            this.errorCount++;
            this.errors.worldFileErrors.push(`World file format error detected: please check Id and Name fields each have values`);
            return false;
        }
        return true;
    }
    
    validateElement(category: string, fileName: string, content: string) {
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
        this.errorCount = 0;
    }
    
}

