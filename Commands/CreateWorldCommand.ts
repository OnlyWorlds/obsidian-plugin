import { App, Notice, PluginManifest, requestUrl } from 'obsidian';

import Handlebars from 'handlebars';
import { v7 as uuidv7 } from 'uuid';
import { ApiResponseModal } from 'Modals/ApiResponseModal';
import { CreateWorldModal, WorldCreationData } from 'Modals/CreateWorldModal';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { Category } from '../enums';
import { LOCAL_WORLD_KEY_TOKEN, classifyWorldKey, worldFileApiKey, writeWorldFileApiKey } from '../vault/world-key';
import { writeWorldIdMarker } from '../vault/world-id-marker';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';
import type { ExportWorldCommand } from './ExportWorldCommand';

export class CreateWorldCommand {
    app: App;
    manifest: PluginManifest;
    /** For the take-online flow: chained upload after linking (optional plumbing). */
    private exportCommand: ExportWorldCommand | null;
    // DEVELOPMENT: Point to local server instead of production
     private apiUrl = 'https://www.onlyworlds.com/api/worldsync/create-world-external/';


    constructor(app: App, manifest: PluginManifest, exportCommand?: ExportWorldCommand) {
        this.app = app;
        this.manifest = manifest;
        this.exportCommand = exportCommand ?? null;
    }

    async execute() { 
        try {
            // Get world creation data using the new unified modal
            const worldData = await this.getWorldCreationData();
            if (!worldData) {
                console.log("World creation cancelled: no data provided.");
                return;  // User cancelled the input
            }

            // Take-online path: an EXISTING local world goes online in one move —
            // server world created under the account (same name), its key written
            // into World.md (replacing the 'local' token), then the upload sweep
            // pushes the elements (with its usual validation preview).
            if (worldData.fromLocal) {
                await this.takeLocalWorldOnline(worldData);
                return;
            }

            // Local-only path: no account, no server call. The world's identity is a
            // client-minted UUID persisted in the .ow-world-id marker (same identity
            // the folder export uses), and World.md carries the explicit 'local'
            // token so sync commands gate instead of falling back to another key.
            if (worldData.localOnly) {
                await this.createLocalWorldFiles(worldData.name, { api_key: LOCAL_WORLD_KEY_TOKEN });
                await writeWorldIdMarker(this.app, worldData.name, uuidv7());
                new Notice(`Local world "${worldData.name}" created. Everything stays in your vault; add an API key to World.md later to enable sync.`, 8000);
                return;
            }

            // Call the API to create the world with the provided data
            const apiResponse = await this.createWorldOnServer(worldData);
            if (!apiResponse) {
                console.log("World creation failed: API call unsuccessful.");
                return;  // API call failed
            }

            // Create local directories and files with the returned data
            await this.createLocalWorldFiles(worldData.name, apiResponse);

            new Notice('Successfully created world: ' + worldData.name);
        } catch (error) {
            console.error("Error during world creation:", error);
            new Notice('Failed to create world: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    }

    /** From-local flow: server create → link World.md → chained upload sweep. */
    private async takeLocalWorldOnline(worldData: WorldCreationData): Promise<void> {
        // Guard: the chosen world must still be local — never overwrite a real key.
        const own = await worldFileApiKey(this.app, worldData.name);
        if (classifyWorldKey(own, undefined).source !== 'local-world') {
            new Notice(`"${worldData.name}" is not a local-only world (its World.md already carries a key). Nothing changed.`);
            return;
        }

        // Validate BEFORE creating anything server-side — a validation failure
        // must not leave an empty orphan world in the user's account.
        if (this.exportCommand && !(await this.exportCommand.validateFor(worldData.name))) {
            new Notice('Fix the issues above and run Take online again — nothing was created on onlyworlds.com.', 8000);
            return;
        }

        const apiResponse = await this.createWorldOnServer(worldData);
        if (!apiResponse || !apiResponse.api_key) {
            console.log('Take-online cancelled: server world creation failed.');
            return;
        }

        const linked = await writeWorldFileApiKey(this.app, worldData.name, String(apiResponse.api_key));
        if (!linked) {
            // Server world exists but the local link failed — tell the user exactly
            // where the key is so nothing is lost.
            new Notice(`World created on onlyworlds.com, but World.md could not be updated. Paste this key into World.md manually: ${apiResponse.api_key}`, 0);
            return;
        }
        new Notice(`"${worldData.name}" is now linked to onlyworlds.com. Uploading elements...`, 6000);

        if (this.exportCommand) {
            // skipPreview: the user already said go via TAKE ONLINE, and the
            // preview's overwrite warning is meaningless for a just-born world.
            await this.exportCommand.executeFor(worldData.pin, worldData.name, { skipPreview: true });
        } else {
            new Notice('Run "Upload World" to push your elements.', 8000);
        }
    }

    async getWorldCreationData(): Promise<WorldCreationData | null> {
        return new Promise((resolve) => {
            const modal = new CreateWorldModal(this.app, resolve);
            modal.open();
        });
    }

    async createWorldOnServer(worldData: WorldCreationData): Promise<any | null> {
        try { 

            const response = await requestUrl({
                url: this.apiUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: worldData.name,
                    email: worldData.email,
                    pin: worldData.pin
                }),
            });

            if (response.status === 200) {
                const data = JSON.parse(response.text);
                
                if (data.success) {
                    // Show success modal
                    return new Promise((resolve) => {
                        new ApiResponseModal(
                            this.app,
                            true,
                            `World "${worldData.name}" created successfully!`,
                            {
                                api_key: data.api_key,
                            },
                            () => resolve(data),
                            null,  // No custom title
                            false  // Don't show details section
                        ).open();
                    });
                } else {
                    // Show error modal for API-reported failure
                    new ApiResponseModal(
                        this.app,
                        false,
                        data.message || "Server reported an error creating the world.",
                        null,
                        () => {},
                        "World Create Failed"
                    ).open();
                    return null;
                }
            } else if (response.status === 400) {
                // Authentication or validation error
                try {
                    // Try to parse response for more detailed error message
                    const data = JSON.parse(response.text);
                    new ApiResponseModal(
                        this.app,
                        false,
                        data.message || "Please verify your OnlyWorlds account email address and PIN and try again.",
                        null,
                        () => {},
                        "World Create Failed"
                    ).open();
                } catch (parseError) {
                    // Fallback if parsing fails
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Please verify your OnlyWorlds account email address and PIN and try again.",
                        null,
                        () => {},
                        "World Create Failed"
                    ).open();
                }
                return null;
            } else if (response.status === 429) {
                // Rate limit error
                try {
                    // Try to parse response for more detailed error message
                    const data = JSON.parse(response.text);
                    new ApiResponseModal(
                        this.app,
                        false,
                        data.message || "Too many requests. Please try again later.",
                        null,
                        () => {},
                        "Rate Limit Exceeded"
                    ).open();
                } catch (parseError) {
                    // Fallback if parsing fails
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Too many requests. Please try again later.",
                        null,
                        () => {},
                        "Rate Limit Exceeded"
                    ).open();
                }
                return null;
            } else {
                // Other HTTP errors
                try {
                    // Try to parse response for more detailed error message
                    const data = JSON.parse(response.text);
                    new ApiResponseModal(
                        this.app,
                        false,
                        data.message || "Server error: Unable to create world.",
                        null,
                        () => {},
                        "World Create Failed"
                    ).open();
                } catch (parseError) {
                    // Fallback if parsing fails
                    new ApiResponseModal(
                        this.app,
                        false,
                        `Server error: Unable to create world.`,
                        null,
                        () => {},
                        "World Create Failed"
                    ).open();
                }
                return null;
            }
        } catch (error) {
            // Network or parsing errors
            let errorMessage = "Unable to connect to OnlyWorlds server.";
            let errorTitle = "Connection Error";
            
            // Log detailed error for debugging
            console.error("World creation API error:", error);
            
            // If we have a more specific error message, use it
            if (error instanceof Error) {
                const errorMsg = error.message;
                
                // Check if this is a 400 error (authentication/validation failure)
                if (errorMsg.includes("status 400") || errorMsg.includes("400 Bad Request")) {
                    console.log("Authentication or validation error detected (400)");
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Please verify your OnlyWorlds account email address and PIN and try again.",
                        null,
                        () => {},
                        "World Create Failed"
                    ).open();
                    return null;
                }
                
                // Check if this is a 429 error (rate limiting)
                if (errorMsg.includes("status 429") || errorMsg.includes("429 Too Many Requests")) {
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Too many requests. Please try again later.",
                        null,
                        () => {},
                        "Rate Limit Exceeded"
                    ).open();
                    return null;
                }
                
                // Check for other common HTTP errors
                if (errorMsg.includes("status ") || /^\d{3}\s/.test(errorMsg)) {
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Server error. Unable to create world.",
                        null,
                        () => {},
                        "World Create Failed"
                    ).open();
                    return null;
                }
                
                // Only show technical details if it's not a standard network error
                if (!errorMsg.includes("Failed to fetch") && 
                    !errorMsg.includes("NetworkError") && 
                    !errorMsg.includes("Network request failed")) {
                    errorMessage += " Error: " + errorMsg;
                }
            }
            
            new ApiResponseModal(
                this.app,
                false,
                errorMessage,
                null,
                () => {},
                errorTitle
            ).open();
            return null;
        }
    }

    async createLocalWorldFiles(worldName: string, worldData: any) {
        // Create base and subdirectories for the world
        const worldBasePath = `OnlyWorlds/Worlds/${worldName}`;
        await this.createFolderIfNeeded(worldBasePath);
        const elementsPath = `${worldBasePath}/Elements`;
        await this.createFolderIfNeeded(elementsPath);
        
        // Create folders for each category
        for (const category in Category) {
            if (isNaN(Number(category))) {  // Skip numeric keys of the enum
                await this.createFolderIfNeeded(`${elementsPath}/${category}`);
            }
        }

        // Create world overview note with data from the API
        const worldNoteData = {
            api_key: worldData.api_key,
            name: worldName,
            description: ``,
            version: "0.30.00",
            image_url: "",  // Empty string rather than null or "None" 
            time_format_names: ["Eon", "Era", "Period", "Epoch", "Age", "Year", "Month", "Day", "Hour", "Minute", "Second"],
            time_format_equivalents: ["Eon", "Era", "Period", "Epoch", "Age", "Year", "Month", "Day", "Hour", "Minute", "Second"],
            time_basic_unit: "Year",
            time_current: 0,
            time_range_min: 0,
            time_range_max: 100
        };
        
        let worldNoteContent = this.compileWorldNote(worldNoteData);
        // Local-only worlds: the how-to lives where the user will look for it.
        // (Prose below the field list is ignored by every World.md parser.)
        if (worldData.api_key === LOCAL_WORLD_KEY_TOKEN) {
            worldNoteContent +=
                `\n## Local-only world\n` +
                `This world lives entirely in your vault — nothing is sent to onlyworlds.com.\n\n` +
                `To take it online later, either:\n` +
                `- run **Create World** and use **Take online** (creates the world under your account and uploads your elements), or\n` +
                `- create a world at [onlyworlds.com](https://www.onlyworlds.com), then replace \`local\` in the API Key line above with its key and run **Upload World**.\n`;
        }
        await this.app.vault.create(`${worldBasePath}/World.md`, worldNoteContent);

        // Create core files (templates, handlebars, etc.)
        // 3.0.0: no legacy template fetch — nothing reads those templates (all
        // note writes go through writeElement / frontmatter). Readme + Settings only.
        const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest, false);
        await createCoreFilesCommand.execute();
    }

    async createFolderIfNeeded(folderPath: string) {
        let existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!existingFolder) {
            try {
                await this.app.vault.createFolder(folderPath);
            } catch (error) {
                console.error(`Error creating folder: ${folderPath}`, error);
            }
        }
    }

    compileWorldNote(data: any): string {
        // noEscape: span-tag note bodies carry plain data, not HTML — see
        // DownloadWorldCommand. Prevents apostrophes/ampersands escaping on disk.
        const template = Handlebars.compile(worldTemplateString, { noEscape: true });
        return template(data);
    }
}
