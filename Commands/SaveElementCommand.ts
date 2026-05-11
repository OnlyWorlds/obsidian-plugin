import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type OnlyWorldsPlugin from '../main';
import { readElement, categoryToResourceKey } from '../vault/element-file';

// Define the structure for element data (adapt as needed based on actual fields)
interface ElementData {
    id?: string; // ID is handled separately for the URL path
    name?: string;
    [key: string]: unknown; // Allow other fields
}

// Define the structure for world file data (adapt as needed)
interface WorldFileData {
    api_key?: string;
    [key: string]: unknown;
}

export class SaveElementCommand {
    app: App;
    plugin: OnlyWorldsPlugin;

    constructor(app: App, plugin: OnlyWorldsPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    // Helper method to convert strings to snake_case
    toSnakeCase(input: string): string {
        // Handle known specific cases first
        if (input === "API Key") return "api_key";
        if (input === "Id") return "id"; // Although ID is removed from payload later

        // General conversion: Add space before uppercase, lowercase, replace space with underscore
        return input
            // Add a space before uppercase letters (but not if it's the start of the string)
            .replace(/([A-Z])/g, ' $1')
            .trim() // Remove potential leading/trailing spaces
            .toLowerCase() // Convert to lowercase
            .replace(/[\s\-]+/g, '_') // Replace spaces and hyphens with underscores
            .replace(/_+/g, '_'); // Collapse multiple underscores (e.g., from acronyms)
    }

    async execute() {
        const activeFile = this.app.workspace.getActiveFile();

        if (!activeFile || !(activeFile instanceof TFile)) {
            new Notice("No active file selected or it's not a valid file.");
            return;
        }

        // 1. Validate Path and Extract Info
        const pathInfo = this.extractPathInfo(activeFile.path);
        if (!pathInfo) {
            new Notice("The current file is not a valid OnlyWorlds element note.");
            return;
        }
        const { worldName, category } = pathInfo;

        // 2. Try v2 (frontmatter) first; fall back to v1 (span-tag) if no frontmatter id.
        let elementData: ElementData | null = null;
        const v2 = await readElement(this.app, activeFile);
        if (v2 && v2.id) {
            elementData = { id: v2.id, ...v2.fields };
        } else {
            const fileContent = await this.app.vault.read(activeFile);
            elementData = await this.parseElementContent(fileContent, activeFile.path);
        }

        if (!elementData) {
             new Notice("Could not parse element data from the note.");
             console.error("Parsing error in:", activeFile.path);
             return;
        }

        const elementUuid = elementData.id;
        if (!elementUuid) {
            new Notice("Could not find element ID in the note after parsing.");
            console.error("Missing ID in parsed data:", elementData);
            return;
        }

        // Remove ID from payload as it's in the URL path
        delete elementData.id;

        // 3. Resolve API Key. Settings tab wins if set; fall back to per-world World.md
        // (legacy storage) so existing vaults keep working.
        let apiKey: string | undefined = this.plugin.settings.apiKey?.trim() || undefined;
        if (!apiKey) {
            const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/World.md`);
            try {
                const worldFile = this.app.vault.getAbstractFileByPath(worldFilePath);
                if (worldFile instanceof TFile) {
                    const worldFileContent = await this.app.vault.read(worldFile);
                    const worldData = this.parseWorldFile(worldFileContent);
                    apiKey = worldData?.api_key;
                    if (!apiKey) {
                         throw new Error("API Key field not found or empty in World.md, and no API key in plugin settings.");
                    }
                } else {
                     throw new Error("World.md file not found or is a folder, and no API key in plugin settings.");
                }
            } catch (error) {
                console.error(`Error accessing or parsing World.md for ${worldName}:`, error);
                new Notice(`Error getting API key: ${error instanceof Error ? error.message : 'Unknown error'}.`);
                return;
            }
        }

        // 4. Build SDK client (pulls cached PIN, or prompts once per session)
        const client = await this.plugin.buildClient(apiKey);
        if (!client) {
            new Notice("Save cancelled: PIN not provided.");
            return;
        }

        // 5. Choose the SDK resource for this category and call update()
        const resource = this.getResource(client as unknown as Record<string, unknown>, category);
        if (!resource) {
            new Notice(`Unknown OnlyWorlds element category: ${category}`);
            return;
        }

        // Strip 'world' field if present — API rejects it on writes (422).
        // SDK does not strip automatically (see open-improvements.md).
        //
        // TODO Phase 3: Add proper read-before-PATCH safety.
        // SDK's update() is PATCH and destructive on text fields and multi-link _ids.
        // Current behavior matches the legacy PUT (full overwrite from local parse),
        // so not a regression — but a real fix requires the frontmatter migration
        // since the span-tag parser already produces a "full" payload from the file.
        const payload: Record<string, unknown> = { ...elementData };
        delete payload.world;
        delete payload.world_id;

        try {
            new Notice(`Saving ${category} "${elementData.name || elementUuid}"...`);
            await resource.update(elementUuid, payload as unknown);
            new Notice(`${category} saved.`);
        } catch (error) {
            console.error('Error during SDK update call:', error);
            const msg = error instanceof Error ? error.message : 'Unknown error';
            new Notice(`Failed to save ${category}: ${msg}`, 10000);
        }
    }

    /**
     * Map a category name (e.g. "Character") to the SDK client's resource accessor.
     * Uses the resource's update()/get()/etc methods. Returns null for unknown categories.
     */
    private getResource(client: Record<string, unknown>, category: string): { update: (id: string, data: unknown) => Promise<unknown> } | null {
        const accessor = categoryToResourceKey(category);
        const resource = client[accessor];
        if (!resource) {
            return null;
        }
        return resource as { update: (id: string, data: unknown) => Promise<unknown> };
    }

    // Helper to extract World Name and Category from path
    extractPathInfo(filePath: string): { worldName: string; category: string } | null {
        // Example path: OnlyWorlds/Worlds/MyWorld/Elements/Character (3)/Hero.md
        const pattern = /^OnlyWorlds\/Worlds\/([^\/]+)\/Elements\/([^\/]+)\/.+\.md$/i;
        const match = filePath.match(pattern);
        if (match && match[1] && match[2]) {
            // Strip count suffix from category name (e.g., "Character (3)" -> "Character")
            const rawCategory = match[2];
            const baseCategoryName = rawCategory.replace(/\s*\(\d+\)$/, '');
         //   console.log(`[SaveElementCommand] Extracted category: "${rawCategory}" -> base: "${baseCategoryName}"`);
            return { worldName: match[1], category: baseCategoryName };
        }
        return null;
    }

    // Refined parser based on ExportWorldCommand's logic
    async parseElementContent(content: string, currentFilePath: string): Promise<ElementData | null> {
     //   console.log("Starting element parsing (v2)...");
        const data: ElementData = {};
        const lines = content.split('\n');

        // Regex to capture key, value, and tooltip:
        const linePattern = /- <span class="[^"]+" data-tooltip="([^"]+)">([^<]+)<\/span>:\s*(.*)/;
        const idPatternSimple = /Id<\/span>:\s*([a-f0-9\-]{36})/; // Separate pattern just for ID

        let foundId: string | null = null; // Track ID separately

        for (const line of lines) {
            // First, specifically check for the ID line
            const idMatchSimple = line.match(idPatternSimple);
            if (idMatchSimple && idMatchSimple[1]) {
                foundId = idMatchSimple[1].trim();
             //   console.log(`  -> Found ID via simple pattern: ${foundId}`);
                continue; // Don't process the ID line with the general pattern
            }

            // Process general key-value lines
            const match = line.match(linePattern);
            if (match) {
                const tooltip = match[1].trim();
                const key = match[2].trim();
                const rawValue = match[3].trim();
                let snakeKey = this.toSnakeCase(key);

                // Skip empty values, API expects null.
                // TTRPG stats need uppercase keys even when null.
                if (!rawValue || rawValue.toLowerCase() === 'none') {
                    const rawKeyLetters = key.replace(/[^a-zA-Z]/g, '').toUpperCase();
                    const ttrpgStats = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
                    const finalKey = ttrpgStats.includes(rawKeyLetters) ? rawKeyLetters : snakeKey;
                    data[finalKey] = null;
                    continue;
                }

              //  console.log(`  -> Field [${key}] (Tooltip: ${tooltip}): Raw value = "${rawValue}"`);

                // --- Handle Links based on Tooltip ---
                if (tooltip.toLowerCase().startsWith('single ') || tooltip.toLowerCase().startsWith('multi ')) {
                    // Get the IDs first
                    const ids = await this.extractLinkedIds(rawValue, tooltip, currentFilePath);
                    
                    // Determine the final key and assign value based on single/multi
                    if (tooltip.toLowerCase().startsWith('single ')) {
                        const finalKey = `${snakeKey}_id`; // Append _id for single links
                        data[finalKey] = ids.length > 0 ? ids[0] : null;
                     //   console.log(`     Recognized as Single Link field. Key: ${finalKey}, Assigned ID = ${data[finalKey]}`);
                    } else { // Must be multi
                        const finalKey = `${snakeKey}_ids`; // Append _ids for multi links
                        data[finalKey] = ids; // Assign array
                   //     console.log(`     Recognized as Multi Link field. Key: ${finalKey}, Assigned IDs = [${ids.join(', ')}]`);
                    }
                }
                // --- Handle Numbers ---
                else if (tooltip.toLowerCase() === 'number') {
                    const num = parseInt(rawValue, 10);
                    // TTRPG stats — API expects uppercase STR/DEX/CON/INT/WIS/CHA.
                    // The raw field name in the span could be "Str", "STR", "str", or "s_t_r"
                    // (the last from snake_casing all-caps input). Normalize from the raw key.
                    const rawKeyLetters = key.replace(/[^a-zA-Z]/g, '').toUpperCase();
                    const ttrpgStats = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
                    const isTtrpgStat = ttrpgStats.includes(rawKeyLetters);
                    const finalKey = isTtrpgStat ? rawKeyLetters : snakeKey;
                    if (!isNaN(num) && /^\d+$/.test(rawValue)) {
                        data[finalKey] = num;
                    } else {
                        console.warn(`     Could not parse number for key "${key}": ${rawValue}. Assigning null.`);
                        data[finalKey] = null;
                    }
                }
                // --- Handle Text (Default) ---
                else {
                    data[snakeKey] = rawValue;
                 //   console.log(`     Recognized as Text: Assigned value = "${rawValue}"`);
                }
            }
        }

        // Add the separately found ID to the data object
        if (foundId) {
            data.id = foundId;
        } else {
             // Fallback: Try to find ID again if not found via simple pattern (less likely now)
             const idFallbackMatch = content.match(/Id<\/span>:\s*([a-f0-9\-]{36})/);
             if (idFallbackMatch && idFallbackMatch[1]) {
                 data.id = idFallbackMatch[1].trim();
              //   console.log(`  -> Found ID via fallback pattern: ${data.id}`);
             }
        }

        // Ensure name is present (simple extraction)
        if (!data.name) {
            const nameMatch = content.match(/Name<\/span>:\s*(.+)/);
            if (nameMatch && nameMatch[1]) {
                data.name = nameMatch[1].trim().split('<')[0].trim();
            //    console.log(`  -> Found Name: ${data.name}`);
            }
        }

       // console.log("Finished element parsing (v2).");
        if (!data.id) {
            console.error("  -> CRITICAL: Element ID could not be found after parsing.");
        }
        return data.id ? data : null; // Return only if ID was found
    }

    // Refined ID extraction based on ExportWorldCommand logic
    async extractLinkedIds(linkedText: string, tooltip: string, currentFilePath: string): Promise<string[]> {
  //      console.log(`    Extracting IDs (v2) for Links: "${linkedText}"`);
        const ids: string[] = [];
        const linkPattern = /\[\[(.*?)\]\]/g; // Find [[Note Name]]
        let match;

        const pathInfo = this.extractPathInfo(currentFilePath);
        if (!pathInfo) {
            console.error("      Cannot extract IDs: World context not found.");
            return ids;
        }
        const { worldName } = pathInfo;

        // Determine the linked category from the tooltip (e.g., "Multi Link Traits" -> "Traits")
        const tooltipParts = tooltip.split(' ');
        const linkedCategory = tooltipParts.length > 1 ? tooltipParts[tooltipParts.length - 1] : null;

        if (!linkedCategory) {
            console.warn(`      Cannot extract IDs: Linked category not determined from tooltip: "${tooltip}"`);
            return ids;
        }
       // console.log(`      Determined linked category: ${linkedCategory}`);

        while ((match = linkPattern.exec(linkedText)) !== null) {
            const noteName = match[1];
      //      console.log(`      Found link: [[${noteName}]]`);
            
            // Find the actual category folder (which might have count suffix)
            const actualCategoryFolder = await this.findCategoryFolderByBaseName(worldName, linkedCategory);
            if (!actualCategoryFolder) {
                console.warn(`      Cannot find category folder for: ${linkedCategory}`);
                continue;
            }
            
            const linkedFilePath = normalizePath(`${actualCategoryFolder}/${noteName}.md`);
        //    console.log(`      Looking for linked file at: ${linkedFilePath}`);

            try {
                const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);
                if (linkedFile instanceof TFile) {
              //      console.log(`        Found linked file.`);
                    const fileContent = await this.app.vault.read(linkedFile);
                    // Use the simpler ID extraction function (like ExportWorldCommand's parseElement)
                    const linkedElementData = this.parseElementIdAndName(fileContent); // NEW helper call
                    if (linkedElementData && linkedElementData.id !== "Unknown Id") {
                        ids.push(linkedElementData.id);
                  //      console.log(`        Successfully extracted ID: ${linkedElementData.id}`);
                    } else {
                        console.warn(`        Could not extract valid ID from linked file: ${linkedFilePath}`);
                    }
                } else {
                    console.warn(`        Linked file not found or is not a file: ${linkedFilePath}`);
                }
            } catch (error) {
                console.error(`        Error reading or parsing linked file ${linkedFilePath}:`, error);
            }
        }
   //     console.log(`    Finished extracting IDs (v2). Found: [${ids.join(', ')}]`);
        return ids;
    }

    // Helper to parse just ID and Name from content (like ExportWorldCommand)
    private parseElementIdAndName(content: string): { id: string, name: string } {
     //   console.log("        Parsing linked element ID/Name...");
        // Match ID: Use the regex from ExportWorldCommand
         const idMatch = content.match(/<span class="text-field" data-tooltip="Text">Id<\/span>:\s*([^\r\n<]+)/); 
         // Match Name: Use the regex from ExportWorldCommand
         const nameMatch = content.match(/<span class="text-field" data-tooltip="Text">Name<\/span>:\s*([^\r\n<]+)/);

         const id = idMatch && idMatch[1] ? idMatch[1].trim() : "Unknown Id";
         const name = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "Unnamed Element"; 
    //     console.log(`        Found ID: ${id}, Name: ${name}`);
         return { id, name };
    }

    // Parser for World.md
    parseWorldFile(content: string): WorldFileData | null {
        const data: WorldFileData = {};
        const apiKeyRegex = /- \*\*API Key:\*\* (\d+)/; // Match "- **API Key:** digits"
        const match = content.match(apiKeyRegex);
        if (match && match[1]) {
            data.api_key = match[1].trim();
        }
        return Object.keys(data).length > 0 ? data : null; // Return null if no key found
    }

    // Helper method to find category folder by base name (handles count suffixes)
    async findCategoryFolderByBaseName(worldName: string, baseCategoryName: string): Promise<string | null> {
        const elementsPath = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements`);
        const elementsFolder = this.app.vault.getAbstractFileByPath(elementsPath);
        
        if (!(elementsFolder instanceof TFolder)) {
            console.warn(`Elements folder not found or not a folder: ${elementsPath}`);
            return null;
        }
        
        for (const child of elementsFolder.children) {
            if (child instanceof TFolder) {
                // Check if folder name starts with the base category name
                if (child.name === baseCategoryName || child.name.startsWith(`${baseCategoryName} (`)) {
                //    console.log(`[SaveElementCommand] Found category folder: ${child.path}`);
                    return child.path;
                }
            }
        }
        
        console.warn(`[SaveElementCommand] Category folder not found for: ${baseCategoryName}`);
        return null;
    }

}
