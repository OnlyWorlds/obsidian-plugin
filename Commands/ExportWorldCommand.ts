import { ValidateExportResultModal } from 'Modals/ValidateExportResultModal';
import { WorldPinSelectionModal } from 'Modals/WorldPinSelectionModal';
import { App, normalizePath, Notice, PluginManifest, requestUrl } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
import { Category } from '../enums';
import { ValidateWorldCommand } from './ValidateWorldCommand';
import type OnlyWorldsPlugin from '../main';

export class ExportWorldCommand {
    app: App;
    manifest: PluginManifest;
    worldService: WorldService;
    plugin: OnlyWorldsPlugin | null;

    private apiUrl = 'https://www.onlyworlds.com/api/worldsync/store/';

    constructor(app: App, manifest: PluginManifest, worldService: WorldService, plugin?: OnlyWorldsPlugin) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
        this.plugin = plugin ?? null;
    }

    async execute() {
        const activeWorldName = await this.worldService.getWorldName(); // Fetch the active world name

        // If a PIN is cached/persisted AND we have an active world, skip the picker.
        const cachedPin = this.plugin ? await this.plugin.pinCache.get() : null;
        if (cachedPin && activeWorldName) {
            const pinNum = parseInt(cachedPin, 10);
            if (!isNaN(pinNum)) {
                await this.runExport(pinNum, activeWorldName);
                return;
            }
        }

        new WorldPinSelectionModal(this.app, async (pin: number, worldFolder: string) => {
            await this.runExport(pin, worldFolder);
        }, activeWorldName).open();
    }

    private async runExport(pin: number, worldFolder: string): Promise<void> {
        const validator = new ValidateWorldCommand(this.app, this.manifest, this.worldService, false);
        await validator.execute(worldFolder);

        const validationModal = new ValidateExportResultModal(this.app, validator.errors, validator.elementCount, validator.errorCount, worldFolder);

        validationModal.setExportCallback(async () => {
            if (validator.errorCount === 0) {
                const worldData = await this.collectWorldData(worldFolder);

                const payload = {
                    pin: pin,
                    world_data: worldData
                };

                try {
                    // throw:false so requestUrl doesn't throw on non-2xx — otherwise the
                    // server's 400 body (which names the exact failing element/field) is lost.
                    const response = await requestUrl({
                        url: this.apiUrl,
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(payload),
                        throw: false
                    });

                    if (response.status === 200 || response.status === 201) {
                        new Notice('Successfully uploaded to onlyworlds.com.');
                    } else if (response.status === 400) {
                        // The 400 body names the exact failing element/field. Surface it.
                        let body: unknown = response.text;
                        try { body = JSON.parse(response.text); } catch { /* not JSON — keep raw text */ }
                        // Stringified so the console shows the body, not a collapsed "Object".
                        console.error('Upload rejected (400):', response.text);
                        const detail = (body && typeof body === 'object' && 'error' in body
                            ? String((body as Record<string, unknown>).error)
                            : response.text) || 'validation failed';
                        new Notice(`Upload failed: ${detail}`, 15000);
                    } else if (response.status === 403) {
                        new Notice('Upload failed: Invalid PIN or insufficient access rights.');
                    } else if (response.status === 429) {
                        new Notice('Upload failed: Rate limit exceeded. Please try again later.');
                    } else {
                        console.error(`Failed to send world data, status code: ${response.status}`, response.text);
                        new Notice(`Failed to send world data: ${response.status}`);
                    }
                } catch (error) {
                    console.error('Upload error:', error);
                    new Notice(`Error during upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
                }
            }
        });

        validationModal.open();
    }
    
    
    

    async collectWorldData(worldFolder: string) {
        const fs = this.app.vault.adapter;
        let worldData: Record<string, unknown> = {};   
    
        // Path to the 'World' file inside the selected world folder
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/World.md`);
    
        // Read the 'World' file content and parse it
        try {
            const worldFileContent = await fs.read(worldFilePath); 
            const worldInfo = this.parseWorldFile(worldFileContent);
            worldData['World'] = worldInfo; // Directly assign the object, not in an array
        } catch (error) {
            console.error('Error reading World file:', error);
            const msg = error instanceof Error ? error.message : String(error);
            new Notice('Failed to read World file: ' + msg);
            return {}; // Stop further processing if the World file cannot be read
        }
    
        // Iterate over categories to collect their data
        for (const categoryKey in Category) {
            const category = Category[categoryKey];
            if (isNaN(Number(category))) {
                const categoryDirectory = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements/${category}`);
                const files = this.app.vault.getFiles().filter(file => file.path.startsWith(categoryDirectory));
     
                const categoryData = await Promise.all(files.map(async (file) => {
                    const fileContent = await fs.read(file.path); 
                    return await this.parseTemplate(fileContent, worldFolder);
                }));
    
                // Filter out empty entries
                worldData[category] = categoryData.filter(item => Object.keys(item).length > 0);
            }
        }
    
        // Add debug logging at the end of the method, before returning the data
        try {
         //   console.log("WORLD DATA COLLECTION COMPLETE - Raw data structure:");
         //   console.log(JSON.stringify(worldData, null, 2));
            
            return worldData;
        } catch (error) {
            console.error("Error collecting world data:", error);
            new Notice("Error collecting world data: " + (error instanceof Error ? error.message : "Unknown error"));
            return null;
        }
    }
    
    private parseWorldFile(content: string): Record<string, string | string[]> {
        let currentSection: string | null = null;
        const data: Record<string, string | string[]> = {};
    
        const sectionPattern = /^##\s*(.+)$/; // Pattern to identify sections
        const keyValuePattern = /- \*\*(.*?):\*\* (.*)/; // Pattern for key-value pairs
    
        const lines = content.split('\n');
        lines.forEach(line => {
            const sectionMatch = line.match(sectionPattern);
            if (sectionMatch) {
                currentSection = this.toSnakeCase(sectionMatch[1]);
                return;
            }
    
            const match = line.match(keyValuePattern);
            if (match) {
                let key = this.toSnakeCase(match[1].replace(/\*\*/g, ''));
                const value = match[2].trim();
                
                // Special handling for image field
                if (key === 'image' || key === 'image_url') {
                    // If the image value is 'None', set it to empty string
                    if (value === 'None' || value === 'No image set') {
                        data[key] = '';
                    } else {
                        data[key] = value;
                    }
                } else if (key === 'time_format_names' || key === 'time_format_equivalents') {
                    // Support both formats:
                    // 1. If the value is already a JSON array string (starts with '[')
                    if (value.startsWith('[') && value.endsWith(']')) {
                        try {
                            // Parse as JSON array
                            data[key] = JSON.parse(value);
                        } catch (e) {
                            // If parsing fails, fall back to comma-separated string
                            data[key] = value.split(',').map(item => item.trim());
                        }
                    } else {
                        // 2. Parse as comma-separated string
                        data[key] = value.split(',').map(item => item.trim());
                    }
                } else {
                    data[key] = value;
                }
            }
        });
    
        return data;
    }
    
    
    
    private async extractLinkedIds(linkedText: string, lineText: string, worldFolder: string): Promise<string[]> {
        const linkPattern = /\[\[(.*?)\]\]/g;
        const ids: string[] = [];
        let match;
    
        // Extract the element type from the surrounding line context
        const elementTypeMatch = /data-tooltip="(Single|Multi) ([^"]+)"/.exec(lineText);
        const elementType = elementTypeMatch ? elementTypeMatch[2] : null; 
    
        if (!elementType) {
            console.error("Element type not found in the linked text");
            return ids;
        }
    
        while ((match = linkPattern.exec(linkedText)) !== null) {
            const linkedName = match[1]; 
    
            // Search for the element by name content instead of constructing file path
            const elementId = await this.findElementIdByName(linkedName, elementType, worldFolder);
            if (elementId) {
                ids.push(elementId);
            } else {
                console.error(`Linked file not found: ${linkedName}`);
            }
        }
        return ids;
    }
    
    private async findElementIdByName(elementName: string, elementType: string, worldFolder: string): Promise<string | null> {
        const categoryDirectory = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements/${elementType}`);
        const files = this.app.vault.getFiles().filter(file => file.path.startsWith(categoryDirectory));
        
        for (const file of files) {
            try {
                const fileContent = await this.app.vault.read(file);
                const { name, id } = this.parseElement(fileContent);
                
                // Match by name content rather than filename
                if (name === elementName) {
                    return id;
                }
            } catch (error) {
                console.error(`Error reading file ${file.path}:`, error);
            }
        }
        
        return null;
    }
    
    async parseTemplate(content: string, worldFolder: string): Promise<Record<string, unknown>> {
        let currentSection: string | null = null;
        const data: Record<string, unknown> = {};

        const sectionPattern = /^##\s*(.+)$/; // Pattern to identify sections
        // Capture the tooltip so link/number fields are typed like SaveElementCommand.
        const keyValuePattern = /- <span class="[^"]+" data-tooltip="([^"]+)">(.+?)<\/span>:\s*(.*)/; // tooltip, key, value

        const lines = content.split('\n');
        for (const line of lines) {
            const sectionMatch = line.match(sectionPattern);
            if (sectionMatch) {
                currentSection = this.toSnakeCase(sectionMatch[1]);
                continue;
            }

            const match = line.match(keyValuePattern);
            if (match) {
                const tooltip = match[1].trim();
                const originalKey = match[2].replace(/\*\*/g, '');
                let key = this.toSnakeCase(originalKey);
                const value = match[3].trim();

                // Special handling for TTRPG stats - use uppercase keys
                const ttrpgStats = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                if (ttrpgStats.includes(key.toLowerCase())) {
                    key = key.toUpperCase();
                }

                const lowerTooltip = tooltip.toLowerCase();
                // --- Links: ship as <field>_id / <field>_ids (UUIDs, never names) ---
                if (lowerTooltip.startsWith('single ') || lowerTooltip.startsWith('multi ')) {
                    const ids = value ? await this.extractLinkedIds(value, line, worldFolder) : [];
                    // A non-wikilink value in a link field can't be resolved to a UUID here
                    // (extractLinkedIds only matches [[Name]]). Never ship a raw name.
                    if (value && !value.includes('[[')) {
                        console.warn(`Link field "${key}" holds a non-wikilink value; nulling instead of shipping a name: "${value}"`);
                    }
                    if (lowerTooltip.startsWith('single ')) {
                        data[`${key}_id`] = ids.length > 0 ? ids[0] : null;
                    } else {
                        data[`${key}_ids`] = ids;
                    }
                }
                // --- Numbers ---
                else if (lowerTooltip === 'number' || ttrpgStats.includes(key.toLowerCase()) || key.match(/^[A-Z]{3}$/)) {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && /^\d+$/.test(value)) {
                        data[key] = num;
                    } else {
                        data[key] = value === '' ? null : value;
                    }
                }
                // --- Image fields ---
                else if (key === 'image' || key === 'image_url') {
                    if (value === 'None' || value === 'No image set') {
                        data[key] = '';
                    } else {
                        data[key] = value;
                    }
                }
                // --- Text (default) ---
                else {
                    // Empty fields ship as null, never "" — the API
                    // 422s "" on integer fields (height, weight, dates),
                    // while null reads as "no value" for every kind.
                    // SaveElementCommand's parser already does this.
                    data[key] = value === '' ? null : value;
                }
            }
        }

        return data;
    }
    
    
    
    private parseElement(content: string): { name: string, id: string } {
        // Adjust the regex to capture the full ID including dashes
        const idMatch = content.match(/<span class="text-field" data-tooltip="Text">Id<\/span>:\s*([^\r\n<]+)/);
        const nameMatch = content.match(/<span class="text-field" data-tooltip="Text">Name<\/span>:\s*([^\r\n<]+)/);
        
        const id = idMatch ? idMatch[1].trim() : "Unknown Id";
        const name = nameMatch ? nameMatch[1].trim() : "Unnamed Element"; 
        
        return { id, name };
    }

    // stop at dash 
    // private parseElement(content: string): { id: string } {
    //     const idMatch = content.match(/<span class="text-field" data-tooltip="Text">ID<\/span>:\s*([^<\r\n-]+)/);
    //     const id = idMatch ? idMatch[1].trim() : "Unknown ID";
    //     return { id };
    // }

  
    // Helper method to convert strings to snake_case
    toSnakeCase(input: string): string {
        return input.toLowerCase().replace(/\s+/g, '_').replace(/\(|\)|,/g, '');
    }
}
