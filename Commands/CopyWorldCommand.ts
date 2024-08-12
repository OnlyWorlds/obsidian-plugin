import { App, Notice, FileSystemAdapter, normalizePath, PluginManifest, TFile } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
import { WorldCopyModal } from 'Modals/WorldCopyModal';
import { Category } from 'enums';
import { ValidateCopyResultModal } from 'Modals/ValidateCopyResultModal';
import { ValidateWorldCommand } from './ValidateWorldCommand';

export class CopyWorldCommand {
    app: App;
    manifest: PluginManifest;
    worldService: WorldService;

    constructor(app: App, manifest: PluginManifest, worldService: WorldService) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
    }

    async execute() {
        const activeWorldName = await this.worldService.getWorldName(); // Fetch the active world name
        if (!activeWorldName) {
            new Notice('No active world selected.');
            return;
        }
     
        const validator = new ValidateWorldCommand(this.app, this.manifest, this.worldService, false);
        await validator.execute(activeWorldName); 

        const validationModal = new ValidateCopyResultModal(this.app, validator.errors, validator.elementCount, validator.errorCount, activeWorldName);
        validationModal.setExportCallback(async () => {
            if (validator.errorCount === 0) {
                await this.copyWorldData(activeWorldName); // Only copy data if there are no errors
            }
        });
        validationModal.open();
    }

    async copyWorldData(activeWorldName: string) {
        const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${activeWorldName}`);
        const worldDataPath = `${worldFolderPath}/World Data File.md`;
        const worldFilePath = `${worldFolderPath}/World.md`;
        const fs = this.app.vault.adapter as FileSystemAdapter;

        // Check if the World file exists before attempting to read
        if (!await fs.exists(worldFilePath)) {
            new Notice('World file does not exist.');
            return;
        }

        try {
            const worldData = await this.collectWorldData(worldFolderPath);
            const worldDataJSON = JSON.stringify(worldData, null, 4);

            // Write or overwrite the World Data File with JSON data
            await fs.write(worldDataPath, worldDataJSON);

            // Copy to clipboard
            navigator.clipboard.writeText(worldDataJSON);

            // Modal confirmation
            new WorldCopyModal(this.app, `${activeWorldName}`).open();
            new Notice(`World data file updated for ${activeWorldName}.`);
        } catch (error) {
            console.error('Error during world data processing:', error);
            new Notice('Failed to process world data.');
        }
    }
    
    async collectWorldData(worldFolder: string) {
        const fs: FileSystemAdapter = this.app.vault.adapter as FileSystemAdapter;
        let worldData: Record<string, any> = {};  // Change from any[] to any for flexible indexing
    
        // Path to the 'World' file inside the selected world folder
        const worldFilePath = normalizePath(`${worldFolder}/World.md`); 
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
                const categoryDirectory = normalizePath(`${worldFolder}/Elements/${category}`);
                const files = this.app.vault.getFiles().filter(file => file.path.startsWith(categoryDirectory));
     
                const categoryData = await Promise.all(files.map(async (file) => {
                    const fileContent = await fs.read(file.path); 
                    return await this.parseTemplate(fileContent);
                }));
    
                // Filter out empty entries
                worldData[category] = categoryData.filter(item => Object.keys(item).length > 0);
            }
        }
    
      //  console.log(`Final world data: ${JSON.stringify(worldData)}`);
        return worldData;
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
                data[key] = value;
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
    
    async parseTemplate(content: string): Promise<Record<string, string>> {
        let currentSection: string | null = null;
        const data: Record<string, string> = {};
    
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
                    // If value contains links, extract IDs
                    const ids = await this.extractLinkedIds(value, line);
                    data[key] = ids.join(',');  
                } else {
                    data[key] = value;
                }
            } else {
               
            }
        }
    
      //  console.log(`Parsed data: ${JSON.stringify(data)}`);
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

   
    toSnakeCase(input: string): string {
        return input.toLowerCase().replace(/\s+/g, '_').replace(/\(|\)|,/g, '');
    }
     
}
