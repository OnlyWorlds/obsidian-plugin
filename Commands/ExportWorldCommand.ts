import { ValidateExportResultModal } from 'Modals/ValidateExportResultModal';
import { WorldPinSelectionModal } from 'Modals/WorldPinSelectionModal';
import { App, FileSystemAdapter, normalizePath, Notice, requestUrl, TFile } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
import { Category } from '../enums';
import { ValidateWorldCommand } from './ValidateWorldCommand';

export class ExportWorldCommand {
    app: App;
    manifest: any;
    worldService: WorldService;

    // DEVELOPMENT: Point to local server instead of production
    private apiUrl = 'http://127.0.0.1:8000/api/worldsync/store/';
    // PRODUCTION: Uncomment this line when deploying to production
    // private apiUrl = 'https://www.onlyworlds.com/api/worldsync/store/';

    constructor(app: App, manifest: any,  worldService: WorldService,) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
    }

    async execute() {
        const activeWorldName = await this.worldService.getWorldName(); // Fetch the active world name
        new WorldPinSelectionModal(this.app, async (pin: number, worldFolder: string) => {
            const validator = new ValidateWorldCommand(this.app, this.manifest, this.worldService, false);
            await validator.execute(worldFolder); 
    
            const validationModal = new ValidateExportResultModal(this.app, validator.errors, validator.elementCount, validator.errorCount, worldFolder);
    
            validationModal.setExportCallback(async () => {
                if (validator.errorCount === 0) {
                    const worldData = await this.collectWorldData(worldFolder);  // Pass the selected world folder

               
                    
                    // Construct payload with PIN and world data
                    const payload = {
                        pin: pin,
                        world_data: worldData
                    };
    
                    try {
                        const response = await requestUrl({
                            url: this.apiUrl,
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify(payload)
                        });
    
                        if (response.status === 200 || response.status === 201) {
                            new Notice('Successfully exported to OnlyWorlds.com.');
                        } else if (response.status === 403) {
                            new Notice('Export failed: Invalid PIN or insufficient access rights.');
                        } else if (response.status === 429) {
                            new Notice('Export failed: Rate limit exceeded. Please try again later.');
                        } else {
                            console.error(`Failed to send world data, status code: ${response.status}`);
                            new Notice(`Failed to send world data: ${response.status}`);
                        }
                    } catch (error) {
                        console.error('Export error:', error);
                        if (error instanceof Error && error.message.includes('status 403')) {
                            new Notice('Export failed: Invalid PIN or insufficient access rights.');
                        } else if (error instanceof Error && error.message.includes('status 429')) {
                            new Notice('Export failed: Rate limit exceeded. Please try again later.');
                        } else {
                            new Notice(`Error during export: ${error instanceof Error ? error.message : 'Unknown error'}`);
                        }
                    }
                }
            });
    
            validationModal.open();
        }, activeWorldName).open(); // Pass the active world name to the modal
    }
    
    
    

    async collectWorldData(worldFolder: string) {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            new Notice('Unexpected adapter type. This feature requires a file system-based vault.');
            return; 
        }             
        const fs: FileSystemAdapter = this.app.vault.adapter;
        let worldData: Record<string, any> = {};   
    
        // Path to the 'World' file inside the selected world folder
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/World.md`);
    
        // Read the 'World' file content and parse it
        try {
            const worldFileContent = await fs.read(worldFilePath); 
            const worldInfo = this.parseWorldFile(worldFileContent);
            worldData['World'] = worldInfo; // Directly assign the object, not in an array
        } catch (error) {
            console.error('Error reading World file:', error);
            new Notice('Failed to read World file: ' + error.message);
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
                    return await this.parseTemplate(fileContent);
                }));
    
                // Filter out empty entries
                worldData[category] = categoryData.filter(item => Object.keys(item).length > 0);
            }
        }
    
        // Add debug logging at the end of the method, before returning the data
        try {
            console.log("WORLD DATA COLLECTION COMPLETE - Raw data structure:");
            console.log(JSON.stringify(worldData, null, 2));
            
            return worldData;
        } catch (error) {
            console.error("Error collecting world data:", error);
            new Notice("Error collecting world data: " + (error instanceof Error ? error.message : "Unknown error"));
            return null;
        }
    }
    
    private parseWorldFile(content: string): Record<string, string> {
        let currentSection: string | null = null;
        const data: Record<string, string> = {};
    
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
                } else {
                    data[key] = value;
                }
            }
        });
    
        return data;
    }
    
    
    
    private async extractLinkedIds(linkedText: string, lineText: string): Promise<string[]> {
        const linkPattern = /\[\[(.*?)\]\]/g;
        const ids: string[] = [];
        let match;
    
        // Extract world name from the active file path
        const currentFile = this.app.workspace.getActiveFile();
        const worldName = currentFile ? this.extractWorldName(currentFile.path) : "Unknown World"; 
    
        // Extract the element type from the surrounding line context
        const elementTypeMatch = /data-tooltip="(Single|Multi) ([^"]+)"/.exec(lineText);
        const elementType = elementTypeMatch ? elementTypeMatch[2] : null; 
    
        if (!elementType) {
            console.error("Element type not found in the linked text");
            return ids;
        }
    
        while ((match = linkPattern.exec(linkedText)) !== null) {
            const noteName = match[1]; 
    
            // Build the correct file path based on the world name and element type
            const linkedFilePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements/${elementType}/${noteName}.md`);
         
            const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);
    
            if (linkedFile && linkedFile instanceof TFile) { 
                const fileContent = await this.app.vault.read(linkedFile);
                const { id } = this.parseElement(fileContent); // Assumes parseElement can extract 'id' from note
                ids.push(id); 
            } else {
                console.error(`Linked file not found: ${noteName}`);
            }
        }
        return ids;
    }
    
    async parseTemplate(content: string): Promise<Record<string, any>> {
        let currentSection: string | null = null;
        const data: Record<string, any> = {};
    
        const sectionPattern = /^##\s*(.+)$/; // Pattern to identify sections
        const keyValuePattern = /- <span class="[^"]+" data-tooltip="[^"]+">(.+?)<\/span>:\s*(.*)/; // Pattern for key-value pairs
    
        const lines = content.split('\n');
        for (const line of lines) {
            const sectionMatch = line.match(sectionPattern);
            if (sectionMatch) {
                currentSection = this.toSnakeCase(sectionMatch[1]); 
                continue;
            }
    
            const match = line.match(keyValuePattern);
            if (match) {
                let key = this.toSnakeCase(match[1].replace(/\*\*/g, ''));
                const value = match[2].trim(); 
    
                if (value.startsWith('[[')) {
                    // If value contains links, extract IDs as an array
                    const ids = await this.extractLinkedIds(value, line);
                    
                    // Store as actual array instead of comma-separated string
                    data[key] = ids;
                } else {
                    // Special handling for image fields
                    if (key === 'image' || key === 'image_url') {
                        // If the image value is 'None', set it to empty string
                        if (value === 'None' || value === 'No image set') {
                            data[key] = '';
                        } else {
                            data[key] = value;
                        }
                    } else {
                        data[key] = value;
                    }
                }
            } else { 
            }
        }
    
        return data;
    }
    
    
    private extractWorldName(filePath: string): string {
        const pathParts = filePath.split('/');
        const worldIndex = pathParts.indexOf('Worlds');
        if (worldIndex !== -1 && pathParts.length > worldIndex + 1) {
            return pathParts[worldIndex + 1];
        }
        return "Unknown World";  // Default if the world name cannot be determined
    }
    
    private parseElement(content: string): { name: string, id: string } {
        console.log("Parsing element content...");
        // Adjust the regex to capture the full ID including dashes
        const idMatch = content.match(/<span class="text-field" data-tooltip="Text">Id<\/span>:\s*([^\s<]+)/);
        const nameMatch = content.match(/<span class="text-field" data-tooltip="Text">Name<\/span>:\s*([^\s<]+)/);
        
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
