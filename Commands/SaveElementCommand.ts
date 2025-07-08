import { PinInputModal } from 'Modals/PinInputModal'; // This modal will be created next
import { App, Notice, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';

// Define the structure for element data (adapt as needed based on actual fields)
interface ElementData {
    id?: string; // ID is handled separately for the URL path
    name?: string;
    [key: string]: any; // Allow other fields
}

// Define the structure for world file data (adapt as needed)
interface WorldFileData {
    api_key?: string;
    [key: string]: any;
}

export class SaveElementCommand {
    app: App; 
     private apiBaseUrl = 'https://www.onlyworlds.com/api/worldapi/'; 


    constructor(app: App) {
        this.app = app;
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
     //   console.log("Executing SaveElementCommand...");
        const activeFile = this.app.workspace.getActiveFile();

        if (!activeFile || !(activeFile instanceof TFile)) {
            new Notice("No active file selected or it's not a valid file.");
            return;
        }
     //   console.log(`Processing file: ${activeFile.path}`);

        // 1. Validate Path and Extract Info
        const pathInfo = this.extractPathInfo(activeFile.path);
        if (!pathInfo) {
            new Notice("The current file is not a valid OnlyWorlds element note.");
        //    console.log(`Invalid path: ${activeFile.path}`);
            return;
        }
        const { worldName, category } = pathInfo;
 //       console.log(`Extracted Path Info: World=${worldName}, Category=${category}`);

        // 2. Read and Parse Element Content using the refined parser
        const fileContent = await this.app.vault.read(activeFile);
        const elementData = await this.parseElementContent(fileContent, activeFile.path);

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
 //       console.log(`Element UUID for URL: ${elementUuid}`);
 
        // Remove ID from payload as it's in the URL path
        delete elementData.id;

        // 3. Get API Key from World.md
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/World.md`);
    //    console.log(`Looking for World.md at: ${worldFilePath}`);
        let apiKey: string | undefined;
        try {
            const worldFile = this.app.vault.getAbstractFileByPath(worldFilePath);
            if (worldFile instanceof TFile) {
                const worldFileContent = await this.app.vault.read(worldFile);
                const worldData = this.parseWorldFile(worldFileContent);
                apiKey = worldData?.api_key;
                if (!apiKey) {
                     throw new Error("API Key field not found or empty in World.md.");
                }
                console.log(`Found API Key: ${apiKey}`);
            } else {
                 throw new Error("World.md file not found or is a folder.");
            }
        } catch (error) {
            console.error(`Error accessing or parsing World.md for ${worldName}:`, error);
            new Notice(`Error getting API key: ${error instanceof Error ? error.message : 'Unknown error'}. Please check World.md.`);
            return;
        }

        // 4. Prompt for PIN
     //   console.log("Prompting for PIN...");
        new PinInputModal(this.app, async (pin: string | null) => {
            if (!pin) {
                new Notice("Save cancelled: PIN not provided.");
             //   console.log("PIN prompt cancelled by user.");
                return;
            }
            console.log("PIN provided.");

            // 5. Construct URL and Payload
            const apiUrl = `${this.apiBaseUrl}${category.toLowerCase()}/${elementUuid}/`;
            const payload = { ...elementData }; // Use the parsed data

            // console.log("--- Sending Payload ---");
            // console.log(JSON.stringify(payload, null, 2));
            // console.log("Target URL:", apiUrl);
            // console.log("API Key:", apiKey); // Don't log PIN
            // console.log("-----------------------");

            // 6. Make API Call
            try {
                new Notice(`Saving ${category} "${elementData.name || elementUuid}"...`);
                const response = await requestUrl({
                    url: apiUrl,
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'API-Key': apiKey!,
                        'API-Pin': pin
                    },
                    body: JSON.stringify(payload),
                });
                console.log(`API Response Status: ${response.status}`);

                // 7. Handle Response
                if (response.status === 200 || response.status === 201) {
                    const responseData = response.json;
                    console.log("API Success Response:", responseData);
                    const message = responseData?.message || `Element ${response.status === 201 ? 'created' : 'updated'} successfully.`;
                    new Notice(message);
                } else {
                     console.log("API Error Response:", response.json);
                     this.handleApiError(response.status, response.json);
                }

            } catch (error) {
                console.error('Error during API requestUrl call:', error);
                 if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') {
                    // Try to get status and body from caught error if requestUrl failed structurally
                     let responseBody = {};
                     try {
                        if (typeof error.body === 'string') responseBody = JSON.parse(error.body);
                        else if (typeof error.body === 'object') responseBody = error.body;
                     } catch(parseErr) { console.error("Failed to parse error body:", parseErr)}
                    this.handleApiError(error.status, responseBody);
                 } else if (error instanceof Error) {
                    new Notice(`Network or processing error: ${error.message}`);
                 } else {
                    new Notice('An unknown error occurred while saving the element.');
                 }
            }
        }).open();
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

                // Skip empty values, API expects null
                if (!rawValue || rawValue.toLowerCase() === 'none') {
                //    console.log(`  -> Field [${key}]: Skipping empty value.`);
                    data[snakeKey] = null;
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
                    if (!isNaN(num) && /^\d+$/.test(rawValue)) {
                        // Special handling for TTRPG stats - use uppercase keys
                        const ttrpgStats = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                        if (ttrpgStats.includes(snakeKey.toLowerCase())) {
                            data[snakeKey.toUpperCase()] = num;
                          //  console.log(`     Recognized as TTRPG Stat: Assigned ${snakeKey.toUpperCase()} = ${num}`);
                        } else {
                            data[snakeKey] = num;
                          //  console.log(`     Recognized as Number: Assigned value = ${num}`);
                        }
                    } else {
                        console.warn(`     Could not parse number for key "${key}": ${rawValue}. Assigning null.`);
                        // Also handle empty TTRPG stats
                        const ttrpgStats = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                        if (ttrpgStats.includes(snakeKey.toLowerCase())) {
                            data[snakeKey.toUpperCase()] = null;
                        } else {
                            data[snakeKey] = null;
                        }
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

    // Error Handler
    handleApiError(status: number, responseData: any) {
        let message = `Error saving element (Status ${status}).`;
        const responseMessage = responseData?.message || responseData?.detail || '';

        let detailMessage = '';
        if (typeof responseData?.detail === 'string') {
            try {
                 const details = JSON.parse(responseData.detail);
                 if (Array.isArray(details)) {
                     detailMessage = details.map((err: any) => `${err.loc?.slice(1).join('.') || 'error'}: ${err.msg}`).join('; ');
                 } else { detailMessage = responseData.detail; }
            } catch (e) { detailMessage = responseData.detail; }
        } else if (responseData?.detail) {
             try { detailMessage = JSON.stringify(responseData.detail); } catch (e) { detailMessage = 'Invalid error detail format'; }
        }

        switch (status) {
            case 400: message = `Bad Request: ${detailMessage || responseMessage || 'Invalid data sent.'}`; break;
            case 401:
            case 403: message = `Authentication Failed: ${responseMessage || 'Invalid API Key or PIN.'}`; break;
            case 404: message = `Not Found: ${responseMessage || 'Element UUID or API endpoint not found.'}`; break;
            case 422: message = `Validation Error: ${detailMessage || responseMessage || 'Invalid data format.'}`; break;
            case 429: message = `Rate Limit Exceeded: ${responseMessage || 'Please try again later.'}`; break;
            case 500:
            default: message = `Server Error (Status ${status}): ${responseMessage || 'Failed to save element on the server.'}`; break;
        }
        console.error("API Error Details:", status, responseData);
        new Notice(message, 10000);
    }
} 