import { Category } from 'enums';
import { ValidateCopyResultModal } from 'Modals/ValidateCopyResultModal';
import { WorldSelectionModal } from 'Modals/WorldSelectionModal';
import { App, FileSystemAdapter, normalizePath, Notice, PluginManifest, TFile, TFolder } from 'obsidian';
import { WorldService } from 'Scripts/WorldService';
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
        const worldFolders = await this.getWorldFolders();
        
        // If only one world exists, skip the selection modal
        if (worldFolders.length === 1) {
            await this.processWorldCopy(worldFolders[0]);
            return;
        }
        
        // If multiple worlds exist, show selection modal
        new WorldSelectionModal(this.app, async (worldFolder: string) => {
            await this.processWorldCopy(worldFolder);
        }, activeWorldName).open(); // Pass the active world name to the modal
    }

    async processWorldCopy(worldFolder: string) {
        const validator = new ValidateWorldCommand(this.app, this.manifest, this.worldService, false);
        await validator.execute(worldFolder); 

        const validationModal = new ValidateCopyResultModal(this.app, validator.errors, validator.elementCount, validator.errorCount, worldFolder);
        validationModal.setExportCallback(async () => {
            if (validator.errorCount === 0) {
                await this.copyWorldData(worldFolder); // Only copy data if there are no errors
            }
        });
        validationModal.open();
    }

    async copyWorldData(worldFolder: string) {
        const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${worldFolder}`);
        const worldFilePath = `${worldFolderPath}/World.md`;
        const worldDataPath = `${worldFolderPath}/World Data File.md`;
    
        // Retrieve the 'World.md' file as a TFile instance
        const worldFile = this.app.vault.getAbstractFileByPath(worldFilePath) as TFile | null;
    
        if (worldFile instanceof TFile) {
            try {
                const worldData = await this.collectWorldData(worldFolderPath); // Assuming this collects data correctly
                const worldDataJSON = JSON.stringify(worldData, null, 4);
    
                // Check if the World Data File exists, create new or modify existing
                let worldDataFile = this.app.vault.getAbstractFileByPath(worldDataPath) as TFile | null;
                if (worldDataFile instanceof TFile) {
                    // Modify existing World Data File
                    await this.app.vault.modify(worldDataFile, worldDataJSON);
                } else {
                    // Create new World Data File if it does not exist
                    worldDataFile = await this.app.vault.create(worldDataPath, worldDataJSON);
                }
    
                // Copy to clipboard
                navigator.clipboard.writeText(worldDataJSON);
    
                // Modal confirmation removed
                new Notice(`World data file updated for ${worldFolder}.`);
            } catch (error) {
                console.error('Error during world data processing:', error);
                new Notice('Failed to process world data.');
            }
        } else {
            new Notice('World file does not exist.');
        }
    }
    
    
    async collectWorldData(worldFolder: string) {
        if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
            new Notice('Unexpected adapter type. This feature requires a file system-based vault.');
            return; 
        }             
        const fs: FileSystemAdapter = this.app.vault.adapter;
        let worldData: Record<string, any> = {};  // Change from any[] to any for flexible indexing
        
        // Extract world name from folder path
        const worldName = worldFolder.split('/').pop() || 'Unknown World';
        // console.log(`Collecting world data for: ${worldName}`);
    
        // Path to the 'World' file inside the selected world folder
        const worldFilePath = normalizePath(`${worldFolder}/World.md`); 
        // Read the 'World' file content and parse it
        try {
            const worldFileContent = await fs.read(worldFilePath); 
            const worldInfo = this.parseWorldFile(worldFileContent);
            
            // Add missing fields with default values to match mobile app format
            const completeWorldInfo = {
                id: worldInfo.id || this.generateUUID(),
                user: worldInfo.user || worldInfo.user_id || 'default_user_id',
                name: worldInfo.name || 'OnlyWorld',
                description: worldInfo.description || '',
                version: worldInfo.version || '00.30',
                image_url: worldInfo.image_url || worldInfo.image || 'default_image_url',
                focus_text: worldInfo.focus_text || '',
                time_format_names: worldInfo.time_format_names || [],
                time_format_equivalents: worldInfo.time_format_equivalents || [],
                time_basic_unit: worldInfo.time_basic_unit || 'Year',
                time_current: worldInfo.time_current || 0,
                time_range_min: worldInfo.time_range_min || 0,
                time_range_max: worldInfo.time_range_max || 100,
                api_key: worldInfo.api_key || '0000000000'
            };
            
            worldData['World'] = completeWorldInfo;
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
                    const parsedElement = await this.parseTemplate(fileContent, worldName);
                    return this.addMissingElementFields(parsedElement, category);
                }));
    
                // Filter out empty entries
                worldData[category] = categoryData.filter(item => Object.keys(item).length > 0);
            }
        }
        
        // Add WorldTyping section
        worldData['WorldTyping'] = this.getWorldTypingData();
    
      //  console.log(`Final world data: ${JSON.stringify(worldData)}`);
        return worldData;
    }
    
    private parseWorldFile(content: string): Record<string, any> {
        let currentSection: string | null = null;
        const data: Record<string, any> = {};
    
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
                let value = match[2].trim();
                
                // Fix field name mappings to match mobile app format
                if (key === 'time_formats') {
                    key = 'time_format_names';
                } else if (key === 'basic_time_unit') {
                    key = 'time_basic_unit';
                } else if (key === 'current_time') {
                    key = 'time_current';
                }
                
                // Handle HTML entity decoding
                value = value.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
                
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
                } else if (this.isWorldNumericField(key)) {
                    // Convert numeric fields to numbers
                    const numValue = parseFloat(value);
                    data[key] = isNaN(numValue) ? 0 : numValue;
                } else {
                    data[key] = value;
                }
            }
        });
    
        return data;
    }
    
    
    
    private async extractLinkedIds(linkedText: string, lineText: string, worldName?: string): Promise<string[]> {
        const linkPattern = /\[\[(.*?)\]\]/g;
        const ids: string[] = [];
        let match;
    
        // Use provided world name or extract from active file path as fallback
        const resolvedWorldName = worldName || (
            () => {
                const currentFile = this.app.workspace.getActiveFile();
                return currentFile ? this.extractWorldName(currentFile.path) : "Unknown World";
            }
        )(); 
    
        // Extract the element type from the surrounding line context
        const elementTypeMatch = /data-tooltip="(Single|Multi) ([^"]+)"/.exec(lineText);
        const elementType = elementTypeMatch ? elementTypeMatch[2] : null;
        
        // Debug logging (can be removed in production)
        // console.log(`Processing linked text: ${linkedText}`);
        // console.log(`Line text: ${lineText}`);
        // console.log(`Extracted element type: ${elementType}`);
        // console.log(`Using world name: ${resolvedWorldName}`); 
    
        if (!elementType) {
            console.warn("Element type not found in the linked text. Attempting to extract IDs without type filtering.");
            // Reset the regex for the fallback search
            const fallbackLinkPattern = /\[\[(.*?)\]\]/g;
            let fallbackMatch;
            while ((fallbackMatch = fallbackLinkPattern.exec(linkedText)) !== null) {
                const noteName = fallbackMatch[1];
                // Search for the file across all element categories
                const foundId = await this.findElementIdByName(noteName, resolvedWorldName);
                if (foundId) {
                    ids.push(foundId);
                }
            }
            return ids;
        }
    
        while ((match = linkPattern.exec(linkedText)) !== null) {
            const noteName = match[1]; 
    
            // Build the correct file path based on the world name and element type
            const linkedFilePath = normalizePath(`OnlyWorlds/Worlds/${resolvedWorldName}/Elements/${elementType}/${noteName}.md`);
            // console.log(`Looking for file at: ${linkedFilePath}`);
    
            const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);
    
            if (linkedFile && linkedFile instanceof TFile) { 
                try {
                    const fileContent = await this.app.vault.read(linkedFile);
                    const { id } = this.parseElement(fileContent); // Assumes parseElement can extract 'id' from note
                    if (id && id !== "Unknown Id") {
                        ids.push(id); 
                    }
                } catch (error) {
                    console.warn(`Error reading linked file ${noteName}:`, error);
                    // Continue processing other links
                }
            } else {
                console.warn(`Linked file not found at ${linkedFilePath}. Attempting fallback search.`);
                // Try fallback search
                const foundId = await this.findElementIdByName(noteName, resolvedWorldName);
                if (foundId) {
                    ids.push(foundId);
                } else {
                    console.warn(`Fallback search also failed for: ${noteName}`);
                }
            }
        }
        return ids;
    }
    
    async parseTemplate(content: string, worldName?: string): Promise<Record<string, any>> {
        let currentSection: string | null = null;
        const data: Record<string, any> = {};
    
        const sectionPattern = /^##\s*(.+)$/; // Pattern to identify sections
        const keyValuePattern = /- <span class="([^"]+)" data-tooltip="([^"]+)">(.+?)<\/span>:\s*(.*)/; // Capture class and tooltip
    
        const lines = content.split('\n');
        for (const line of lines) {
            const sectionMatch = line.match(sectionPattern);
            if (sectionMatch) {
                currentSection = this.toSnakeCase(sectionMatch[1]); 
                continue;
            }
    
            const match = line.match(keyValuePattern);
            if (match) {
                const spanClass = match[1];
                const tooltip = match[2];
                let key = this.toSnakeCase(match[3].replace(/\*\*/g, ''));
                let value = match[4].trim(); 
    
                // Determine field type from CSS class and tooltip
                const fieldType = this.getFieldType(spanClass, tooltip);
    
                if (value.startsWith('[[')) {
                    // If value contains links, extract IDs as an array
                    const ids = await this.extractLinkedIds(value, line, worldName);
                    data[key] = fieldType === 'single_link' ? (ids.length > 0 ? ids[0] : '') : ids;
                } else {
                    // Process based on detected field type
                    switch (fieldType) {
                        case 'number':
                            const numValue = parseFloat(value);
                            data[key] = isNaN(numValue) ? 0 : numValue;
                            break;
                        case 'multi_link':
                        case 'array':
                            if (value === '' || value === 'None') {
                                data[key] = [];
                            } else {
                                data[key] = value.split(',').map(item => item.trim()).filter(item => item !== '');
                            }
                            break;
                        case 'single_link':
                            data[key] = value === '' || value === 'None' ? '' : value;
                            break;
                        case 'text':
                        default:
                            // Special handling for image fields
                            if (key === 'image' || key === 'image_url') {
                                data[key] = (value === 'None' || value === 'No image set') ? '' : value;
                            } else {
                                data[key] = value;
                            }
                            break;
                    }
                }
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
    
    // Dynamic field type detection based on CSS classes and tooltips
    private getFieldType(spanClass: string, tooltip: string): string {
        // Check CSS classes for field type indicators
        if (spanClass.includes('number-field') || spanClass.includes('integer')) {
            return 'number';
        }
        if (spanClass.includes('multi-link-field') || tooltip.toLowerCase().startsWith('multi')) {
            return 'multi_link';
        }
        if (spanClass.includes('link-field') || tooltip.toLowerCase().startsWith('single')) {
            return 'single_link';
        }
        if (spanClass.includes('text-field') || spanClass.includes('string')) {
            return 'text';
        }
        
        // Fallback to text type
        return 'text';
    }
    
    // Helper method for World file numeric fields (minimal hardcoding for World-specific fields only)
    private isWorldNumericField(key: string): boolean {
        const worldNumericFields = [
            'time_current', 'time_range_min', 'time_range_max'
        ];
        return worldNumericFields.includes(key);
    }
    
    // Helper method to find element ID by name across all categories
    private async findElementIdByName(noteName: string, worldName: string): Promise<string | null> {
        // console.log(`Searching for element: ${noteName} in world: ${worldName}`);
        
        // Search across all categories for a file with this name
        for (const categoryKey in Category) {
            const category = Category[categoryKey];
            if (isNaN(Number(category))) {
                const possiblePath = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements/${category}/${noteName}.md`);
                const file = this.app.vault.getAbstractFileByPath(possiblePath);
                
                if (file && file instanceof TFile) {
                    // console.log(`Found file at: ${possiblePath}`);
                    try {
                        const fileContent = await this.app.vault.read(file);
                        const { id } = this.parseElement(fileContent);
                        if (id && id !== "Unknown Id") {
                            // console.log(`Extracted ID: ${id} for ${noteName}`);
                            return id;
                        }
                    } catch (error) {
                        console.warn(`Error reading file ${possiblePath}:`, error);
                        continue;
                    }
                }
            }
        }
        console.warn(`Could not find element with name: ${noteName} in any category`);
        return null;
    }
    
    // Helper method to generate UUID
    private generateUUID(): string {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            const r = Math.random() * 16 | 0;
            const v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    
    // Simplified method to ensure essential fields exist without hardcoding category schemas
    private addMissingElementFields(element: Record<string, any>, category: string): Record<string, any> {
        // Only ensure absolutely essential fields exist
        const result = {
            id: element.id || this.generateUUID(),
            name: element.name || 'Unnamed',
            description: element.description || '',
            supertype: element.supertype || 'None',
            subtype: element.subtype || 'None',
            image_url: element.image_url || element.image || '',
            ...element // Spread all existing parsed fields
        };
        
        // Handle special case field name mappings for TTRPG stats
        if (element.str !== undefined) {
            result.STR = element.str;
            delete result.str; // Remove lowercase version
        }
        if (element.dex !== undefined) {
            result.DEX = element.dex;
            delete result.dex; // Remove lowercase version
        }
        if (element.con !== undefined) {
            result.CON = element.con;
            delete result.con; // Remove lowercase version
        }
        if (element.int !== undefined) {
            result.INT = element.int;
            delete result.int; // Remove lowercase version
        }
        if (element.wis !== undefined) {
            result.WIS = element.wis;
            delete result.wis; // Remove lowercase version
        }
        if (element.cha !== undefined) {
            result.CHA = element.cha;
            delete result.cha; // Remove lowercase version
        }
        
        // Remove invalid 'world' field that shouldn't be in elements
        delete result.world;
        
        return result;
    }
    
    async getWorldFolders(): Promise<string[]> { 
        const worldsPath = normalizePath('OnlyWorlds/Worlds/');
        const worldsFolder = this.app.vault.getAbstractFileByPath(worldsPath);

        if (!(worldsFolder instanceof TFolder)) {
            console.error('Expected worlds folder not found.');
            return [];  
        }

        return worldsFolder.children
            .filter(child => child instanceof TFolder && child.children.some(file => file instanceof TFile && file.name === "World.md"))
            .map(folder => folder.name);
    }

    // Helper method to get WorldTyping data
    private getWorldTypingData(): Record<string, string> {
        return {
            ability_string: "A special skill or capacity in an entity to perform actions",
            ability_grouping: "Mechanics(activation,duration,potency,range,effects,challenges,talents,requisites)World(prevalence,tradition,source,locus,systems,instruments)",
            character_string: "An actor with agency and autonomy",
            character_grouping: "Constitution(physicality,mentality,height,weight,species,traits,abilities)Origins(background,motivations,birth_date,birthplace,languages)World(reputation,location,objects,institutions)Personality(charisma,coercion,competence,compassion,creativity,courage)Social(family,friends,rivals)TTRPG(level,STR,DEX,CON,INT,WIS,CHA,hit_points)",
            collective_string: "A group of actors regarded as a whole and defined by a common feature or goal",
            collective_grouping: "Formation(composition,count,formation_date,operator,equipment)Dynamics(activity,disposition,state,abilities,symbolism)World(species,characters,creatures,phenomena)",
            construct_string: "An abstract concept or theoretical entity devised or described by a mind",
            construct_grouping: "Nature(rationale,history,status,reach,start_date,end_date,founder,custodian)Involves(characters,objects,locations,species,creatures,institutions,traits,collectives,zones,abilities,phenomena,languages,families,relations,titles,constructs,events)",
            creature_string: "A living being with instinctual behaviour",
            creature_grouping: "Biology(appearance,weight,height,species)Behaviour(habits,demeanor,traits,abilities,languages)World(status,birth_date,location,zone)TTRPG(challenge_rating,hit_points,armor_class,speed,actions)",
            event_string: "A significant occurrence within the world's timeline",
            event_grouping: "Nature(history,challenges,consequences,start_date,end_date,triggers)Involves(characters,objects,locations,species,creatures,institutions,traits,collectives,zones,abilities,phenomena,languages,families,relations,titles,constructs)",
            family_string: "Kinship groupings, related by blood or affinity",
            family_grouping: "Identity(spirit,history,traditions,traits,abilities,languages,ancestors)World(reputation,estates,governs,heirlooms,creatures)",
            institution_string: "A structure of purpose and execution for actors to operate in or with",
            institution_grouping: " Foundation(doctrine,founding_date,parent_institution,dominion)Claims(zones,objects,creatures)World(status,allies,adversaries,constructs)Operation(characters,locations,collectives,titles,events)",
            language_string: "Words, rules, and the art of stringing them together",
            language_grouping: "Structure(phonology,grammar,lexicon,writing,classification)World(status,spread,dialects,species)",
            law_string: "The fine print in the world's contract",
            law_grouping: "Code(declaration,purpose,date,parent_law,penalties)World(author,locations,zones,prohibitions,adjudicators,enforcers,employers)",
            location_string: "A defined area or place, significant within its context",
            location_grouping: "Setting(form,function,founding_date,parent_location,populations)Politics(political_climate,primary_power,governing_title,secondary_powers,zone,rival,partner)Production(extraction_methods,extraction_goods,industry_methods,industry_goods)Commerce(infrastructure,extraction_markets,industry_markets,currencies)Construction(architecture,buildings,building_methods)World(customs,founders,cults,delicacies)Defense(defensibility,elevation,fighters,defensive_objects)",
            map_string: "A visual representation of a stretch of terrain",
            map_grouping: "Group(field)",
            object_string: "The stuff of the physical realm",
            object_grouping: "Form(aesthetics,weight,amount,parent_object,materials,technology,components)Function(utility,effects,abilities,consumes)World(origins,location,titles,claimants,language,affinities)",
            phenomenon_string: "A remarkable or extraordinary occurrence",
            phenomenon_grouping: "Mechanics(expression,effects,duration,catalysts,empowerments)World(mythology,system,triggers,wielders,environments)",
            pin_string: "Map placement component",
            pin_grouping: "Group(field)",
            relation_string: "Strings that tie the elements together ",
            relation_grouping: "Nature(background,start_date,end_date,intensity,actor,events)Involves(characters,objects,locations,species,creatures,institutions,traits,collectives,zones,abilities,phenomena,languages,families,titles,constructs,narratives)",
            species_string: "Classifications of organisms sharing common characteristics",
            species_grouping: " Biology(appearance,life_span,weight,nourishment,reproduction,adaptations)Psychology(instincts,sociality,temperament,communication,aggression,traits)World(role,parent_species,locations,zones,affinities,predators)",
            title_string: "Mandate(authority,eligibility,grant_date,revoke_date,issuer,body,superior_title,holders,symbols)World(status,history,characters,institutions,families,zones,locations,objects,constructs,laws,collectives,creatures,phenomena,species,languages)",
            title_grouping: "Mandate(authority,eligibility,grant_date,revoke_date,issuer,body,superior_title,holders,symbols)World(status,history,characters,institutions,families,zones,locations,objects,constructs,laws,collectives,creatures,phenomena,species,languages)",
            trait_string: "An inherent quality or characteristic",
            trait_grouping: "Qualitative(social_effects,physical_effects,functional_effects,personality_effects,behaviour_effects)Quantitative(charisma,coercion,competence,compassion,creativity,courage)World(significance,anti_trait,empowered_abilities,characters,creatures)",
            zone_string: "A designated area",
            zone_grouping: "Scope(role,start_date,end_date,phenomena,linked_zones)World(context,populations,titles,principles)"
        };
    }
     
}
