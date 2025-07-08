import { App, Notice, PluginManifest, requestUrl } from 'obsidian';

import Handlebars from 'handlebars';
import { ApiResponseModal } from 'Modals/ApiResponseModal';
import { CreateWorldModal, WorldCreationData } from 'Modals/CreateWorldModal';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { Category } from '../enums';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';

export class CreateWorldCommand {
    app: App;
    manifest: PluginManifest;
    // DEVELOPMENT: Point to local server instead of production 
     private apiUrl = 'https://www.onlyworlds.com/api/worldsync/create-world-external/'; 
     

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute() { 
        try {
            // Get world creation data using the new unified modal
            const worldData = await this.getWorldCreationData();
            if (!worldData) {
                console.log("World creation cancelled: no data provided.");
                return;  // User cancelled the input
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
        
        const worldNoteContent = this.compileWorldNote(worldNoteData);
        await this.app.vault.create(`${worldBasePath}/World.md`, worldNoteContent);

        // Create core files (templates, handlebars, etc.)
        const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest);
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
        const template = Handlebars.compile(worldTemplateString);
        return template(data);
    }
}
