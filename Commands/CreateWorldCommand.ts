import { App, Notice, PluginManifest, requestUrl } from 'obsidian';

import Handlebars from 'handlebars';
import { ApiResponseModal } from 'Modals/ApiResponseModal';
import { EmailInputModal } from 'Modals/EmailInputModal';
import { WorldNameModal } from 'Modals/WorldNameModal';
import { worldTemplateString } from 'Scripts/WorldDataTemplate';
import { Category } from '../enums';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';

export class CreateWorldCommand {
    app: App;
    manifest: PluginManifest;
    // DEVELOPMENT: Point to local server instead of production
    private apiUrl = 'http://127.0.0.1:8000/api/worldsync/create-world-external/';
    // PRODUCTION: Uncomment this line when deploying to production
    // private apiUrl = 'https://www.onlyworlds.com/api/worldsync/create-world-external/';
    
    private testMode = false; // Set this to true to use the test API

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }

    async execute() { 
        try {
            // Step 1: Get world name
            const worldName = await this.getWorldName();
            if (!worldName) {
                console.log("World creation cancelled: no world name provided.");
                return;  // User cancelled the input
            }

            // Step 2: Get user email
            const email = await this.getUserEmail(worldName);
            if (!email) {
                console.log("World creation cancelled: no email provided.");
                return;  // User cancelled the input
            }

            // Step 3: Call the API to create the world
            const worldData = await this.createWorldOnServer(worldName, email);
            if (!worldData) {
                console.log("World creation failed: API call unsuccessful.");
                return;  // API call failed
            }

            // Step 4: Create local directories and files with the returned data
            await this.createLocalWorldFiles(worldName, worldData);

            new Notice('Successfully created world: ' + worldName);
        } catch (error) {
            console.error("Error during world creation:", error);
            new Notice('Failed to create world: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
    }

    async getWorldName(): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new WorldNameModal(this.app, resolve);
            modal.open();
        });
    }

    async getUserEmail(worldName: string): Promise<string | null> {
        return new Promise((resolve) => {
            const modal = new EmailInputModal(this.app, worldName, resolve);
            modal.open();
        });
    }

    async createWorldOnServer(name: string, email: string): Promise<any | null> {
        try {
            // If in test mode, return a mocked successful response
            if (this.testMode) {
                console.log("TEST MODE: Simulating successful API response");
                return new Promise((resolve) => {
                    new ApiResponseModal(
                        this.app,
                        true,
                        `TEST MODE: World "${name}" created successfully!`,
                        {
                            world_id: "test-uuid-" + Date.now(),
                            api_key: "1234567890",
                        },
                        () => resolve({
                            world_id: "test-uuid-" + Date.now(),
                            api_key: "1234567890",
                        })
                    ).open();
                });
            }

            const response = await requestUrl({
                url: this.apiUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    name: name,
                    email: email,
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
                            `World "${name}" created successfully!`,
                            {
                                world_id: data.world_id,
                                api_key: data.api_key,
                            },
                            () => resolve(data)
                        ).open();
                    });
                } else {
                    // Show error modal for API-reported failure
                    new ApiResponseModal(
                        this.app,
                        false,
                        data.message || "Server reported an error creating the world.",
                        null
                    ).open();
                    return null;
                }
            } else if (response.status === 429) {
                // Rate limit error
                const data = JSON.parse(response.text);
                new ApiResponseModal(
                    this.app,
                    false,
                    data.message || "Too many requests. Please try again later.",
                    null
                ).open();
                return null;
            } else {
                // Other HTTP errors
                new ApiResponseModal(
                    this.app,
                    false,
                    `Server error (${response.status}): Unable to create world.`,
                    null
                ).open();
                return null;
            }
        } catch (error) {
            // Network or parsing errors
            new ApiResponseModal(
                this.app,
                false,
                `Connection error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                null
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
            id: worldData.world_id,
            api_key: worldData.api_key,
            name: worldName,
            description: ``,
            user_id: "",
            ow_version: "16.10",
            image_url: "",
            focus_text: "",
            time_format_names: "Eon, Era, Period, Epoch, Age, Year, Month, Day, Hour, Minute, Second",
            time_format_equivalents: "Eon, Era, Period, Epoch, Age, Year, Month, Day, Hour, Minute, Second",
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
