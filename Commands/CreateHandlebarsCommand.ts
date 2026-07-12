import { App, Notice, normalizePath } from 'obsidian';
import { Category } from '../enums';

// Map/Pin/Marker were added to the schema after the upstream obsidian_handlebars
// set was authored, so GitHub has no template for them (404). Without a template,
// DownloadWorldCommand silently skips those elements. These inline fallbacks match
// the upstream span format exactly (text-field / integer / link-field tooltips) so
// both parsers (Save and Export) round-trip them. Fields sourced from the SDK types.
const inlineHandlebars: Record<string, string> = {
    Map: `## Base
- <span class="text-field" data-tooltip="Text">Name</span>: {{name}}
- <span class="text-field" data-tooltip="Text">Description</span>: {{description}}
- <span class="text-field" data-tooltip="Text">Supertype</span>: {{supertype}}
- <span class="text-field" data-tooltip="Text">Subtype</span>: {{subtype}}

## Details
- <span class="string" data-tooltip="Text">Background_color</span>: {{background_color}}
- <span class="integer" data-tooltip="Number">Hierarchy</span>: {{hierarchy}}
- <span class="integer" data-tooltip="Number">Width</span>: {{width}}
- <span class="integer" data-tooltip="Number">Height</span>: {{height}}
- <span class="integer" data-tooltip="Number">Depth</span>: {{depth}}
- <span class="link-field" data-tooltip="Single Map">Parent_map</span>: {{linkify parent_map}}
- <span class="link-field" data-tooltip="Single Location">Location</span>: {{linkify location}}

- <span class="text-field" data-tooltip="Text">Id</span>: {{id}}
- <span class="text-field" data-tooltip="Text">Image url</span>: {{image_url}}
`,
    Pin: `## Base
- <span class="text-field" data-tooltip="Text">Name</span>: {{name}}
- <span class="text-field" data-tooltip="Text">Description</span>: {{description}}
- <span class="text-field" data-tooltip="Text">Supertype</span>: {{supertype}}
- <span class="text-field" data-tooltip="Text">Subtype</span>: {{subtype}}

## Details
- <span class="link-field" data-tooltip="Single Map">Map</span>: {{linkify map}}
- <span class="string" data-tooltip="Text">Element_type</span>: {{element_type}}
- <span class="string" data-tooltip="Text">Element_id</span>: {{element_id}}
- <span class="integer" data-tooltip="Number">X</span>: {{x}}
- <span class="integer" data-tooltip="Number">Y</span>: {{y}}
- <span class="integer" data-tooltip="Number">Z</span>: {{z}}

- <span class="text-field" data-tooltip="Text">Id</span>: {{id}}
- <span class="text-field" data-tooltip="Text">Image url</span>: {{image_url}}
`,
    Marker: `## Base
- <span class="text-field" data-tooltip="Text">Name</span>: {{name}}
- <span class="text-field" data-tooltip="Text">Description</span>: {{description}}
- <span class="text-field" data-tooltip="Text">Supertype</span>: {{supertype}}
- <span class="text-field" data-tooltip="Text">Subtype</span>: {{subtype}}

## Details
- <span class="link-field" data-tooltip="Single Map">Map</span>: {{linkify map}}
- <span class="link-field" data-tooltip="Single Zone">Zone</span>: {{linkify zone}}
- <span class="integer" data-tooltip="Number">X</span>: {{x}}
- <span class="integer" data-tooltip="Number">Y</span>: {{y}}
- <span class="integer" data-tooltip="Number">Z</span>: {{z}}
- <span class="integer" data-tooltip="Number">Order</span>: {{order}}

- <span class="text-field" data-tooltip="Text">Id</span>: {{id}}
- <span class="text-field" data-tooltip="Text">Image url</span>: {{image_url}}
`
};

export class CreateHandlebarsCommand {
    app: App;
    manifest: any;

    constructor(app: App, manifest: any) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute(): Promise<void> {
        await this.ensureAllHandlebars();
    }

    // Creates only the handlebar templates that are missing, for ALL categories.
    // Idempotent: existing files (including user-customized ones) are never touched.
    // Legacy categories fetch from GitHub; Map/Pin/Marker use inline fallbacks.
    async ensureAllHandlebars(): Promise<void> {
        const handlebarsFolder = normalizePath('OnlyWorlds/PluginFiles/Handlebars');
        const categories = Object.keys(Category).filter(key => isNaN(Number(key)));

        // Ensure the Handlebars folder exists
        await this.createFolderIfNeeded(handlebarsFolder);

        // Base URL for fetching the Handlebars templates from GitHub
        const githubBaseUrl = 'https://raw.githubusercontent.com/OnlyWorlds/OnlyWorlds/main/languages/obsidian_handlebars/';

        for (const category of categories) {
            const fileName = `${category}Handlebar.md`; // Example: CharacterHandlebar.md
            const targetPath = normalizePath(`${handlebarsFolder}/${fileName}`);

            // Don't clobber an existing (possibly user-customized) template.
            if (this.app.vault.getAbstractFileByPath(targetPath)) {
                continue;
            }

            // Categories added after the upstream set: write the inline fallback.
            if (inlineHandlebars[category]) {
                try {
                    await this.app.vault.create(targetPath, inlineHandlebars[category]);
                    console.log(`Handlebars template ${fileName} created from inline fallback.`);
                } catch (error) {
                    console.error(`Error writing inline Handlebars template for ${category}:`, error);
                    new Notice(`Error creating Handlebars template for ${category}.`);
                }
                continue;
            }

            const templateUrl = `${githubBaseUrl}${fileName}`;
            try {
                // Fetch the Handlebars template from GitHub
                const response = await fetch(templateUrl);
                if (!response.ok) {
                    throw new Error(`Failed to fetch template: ${templateUrl}`);
                }
                const content = await response.text();

                // Write the content to the user's vault in the Handlebars folder
                await this.app.vault.create(targetPath, content);
                console.log(`Handlebars template ${fileName} created successfully.`);
            } catch (error) {
                console.error(`Error fetching Handlebars template for ${category}:`, error);
                new Notice(`Error fetching Handlebars template for ${category}.`);
            }
        }
    }

    // Function to create the folder if it doesn't exist
    async createFolderIfNeeded(folderPath: string) {
        try {
            const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!existingFolder) {
                await this.app.vault.createFolder(folderPath);
            }
        } catch (error) {
            console.error(`Error creating folder: ${folderPath}`, error);
            new Notice('Error: Could not create folder.');
        }
    }
}
