import { App, Notice, PluginManifest, TFolder, normalizePath, requestUrl } from 'obsidian';

import Handlebars from 'handlebars';
import { v7 as uuidv7 } from 'uuid';
import { ApiResponseModal } from '../Modals/ApiResponseModal';
import { CreateWorldModal, WorldCreationData } from '../Modals/CreateWorldModal';
import { worldTemplateString } from '../Scripts/WorldDataTemplate';
import { Category } from '../enums';
import { LOCAL_WORLD_KEY_TOKEN, classifyWorldKey, worldFileApiKey, writeWorldFileApiKey } from '../vault/world-key';
import { safeWorldFolderName } from '../vault/world-name';
import { writeWorldIdMarker } from '../vault/world-id-marker';
import { writeWorldBasesFileQuietly } from '../vault/bases-writer';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';
import type { ExportWorldCommand } from './ExportWorldCommand';
import { createAccountWorld, isFullWriteKey, listAccountWorlds, mintVaultKey, revokeCreateKeys, type CreatedWorld } from '../account/account-api';
import { V2ApiError, V2Client } from '../client-v2';

export class CreateWorldCommand {
    app: App;
    manifest: PluginManifest;
    /** For the take-online flow: chained upload after linking (optional plumbing). */
    private exportCommand: ExportWorldCommand | null;
    // DEVELOPMENT: Point to local server instead of production
     private apiUrl = 'https://www.onlyworlds.com/api/worldsync/create-world-external/';


    /** The signed-in account, or null: signed in, Create World online goes through the account (OW Infra #358). */
    private account: () => { token: string; username: string } | null;

    /** Whether a new world gets its Bases file (the setting; on by default, OW Infra #188). */
    private writeBases: () => boolean;

    constructor(
        app: App,
        manifest: PluginManifest,
        exportCommand?: ExportWorldCommand,
        account?: () => { token: string; username: string } | null,
        writeBases?: () => boolean
    ) {
        this.app = app;
        this.manifest = manifest;
        this.exportCommand = exportCommand ?? null;
        this.account = account ?? (() => null);
        this.writeBases = writeBases ?? (() => true);
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
                await writeWorldIdMarker(this.app, safeWorldFolderName(worldData.name), uuidv7());
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
            // Signed in, a stand-in key: the create route's own key goes once the vault's has landed.
            await apiResponse.afterLanding?.();

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
        await apiResponse.afterLanding?.();
        new Notice(`"${worldData.name}" is now linked to onlyworlds.com. Uploading elements...`, 6000);

        if (this.exportCommand) {
            // skipPreview: the user already said go via TAKE ONLINE, and the
            // preview's overwrite warning is meaningless for a just-born world.
            await this.exportCommand.executeFor(worldData.pin, worldData.name, { skipPreview: true });
        } else {
            new Notice('Run "Upload world" to push your elements.', 8000);
        }
    }

    async getWorldCreationData(): Promise<WorldCreationData | null> {
        const account = this.activeAccount();
        return new Promise((resolve) => {
            const modal = new CreateWorldModal(this.app, resolve, account ? { username: account.username } : undefined);
            modal.open();
        });
    }

    private activeAccount(): { token: string; username: string } | null {
        const a = this.account();
        return a && a.token ? a : null;
    }

    async createWorldOnServer(worldData: WorldCreationData): Promise<any | null> {
        const account = this.activeAccount();
        if (account) return this.createWorldOnAccount(account, worldData);
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
                            `World "${worldData.name}" created.`,
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
                        "World create failed"
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
                        data.message || "Email address or PIN not accepted. Check both and try again.",
                        null,
                        () => {},
                        "World create failed"
                    ).open();
                } catch (parseError) {
                    // Fallback if parsing fails
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Email address or PIN not accepted. Check both and try again.",
                        null,
                        () => {},
                        "World create failed"
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
                        data.message || "Too many requests. Try again later.",
                        null,
                        () => {},
                        "Rate limit exceeded"
                    ).open();
                } catch (parseError) {
                    // Fallback if parsing fails
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Too many requests. Try again later.",
                        null,
                        () => {},
                        "Rate limit exceeded"
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
                        "World create failed"
                    ).open();
                } catch (parseError) {
                    // Fallback if parsing fails
                    new ApiResponseModal(
                        this.app,
                        false,
                        `Server error: Unable to create world.`,
                        null,
                        () => {},
                        "World create failed"
                    ).open();
                }
                return null;
            }
        } catch (error) {
            // Network or parsing errors
            let errorMessage = "Unable to connect to OnlyWorlds server.";
            let errorTitle = "Connection error";
            
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
                        "Email address or PIN not accepted. Check both and try again.",
                        null,
                        () => {},
                        "World create failed"
                    ).open();
                    return null;
                }
                
                // Check if this is a 429 error (rate limiting)
                if (errorMsg.includes("status 429") || errorMsg.includes("429 Too Many Requests")) {
                    new ApiResponseModal(
                        this.app,
                        false,
                        "Too many requests. Try again later.",
                        null,
                        () => {},
                        "Rate limit exceeded"
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
                        "World create failed"
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

    /**
     * Signed in: POST /api/v2/account/worlds creates the world under the
     * account (the PIN goes only if keel says the account has none yet). The
     * create route names its own key nothing ("no name" on the account's keys
     * page, Seethe's walk, h37 #6462), so the vault always mints its own key
     * with mintVaultKey, named for the vault exactly as Download World names
     * it, and `afterLanding`, called once that key is in World.md, revokes the
     * create route's key (DELETE /api/v2/account/worlds/{id}/keys/{key_id}):
     * the keys page still holds one key per vault. Should that mint fail, the
     * create route's key serves, unnamed, rather than strand the new world.
     * Answers in the old route's shape ({api_key}) so both callers go on as before.
     */
    /**
     * True only when keel says the typed PIN is not the account's: a world the
     * account owns whose key this vault holds is read with the PIN, and keel
     * checks a PIN that is sent even on a read (D93). With no such key, or any
     * other answer, the PIN is not judged here (false).
     */
    private async typedPinIsWrong(token: string, pin: string): Promise<boolean> {
        let owned: Set<string>;
        try {
            owned = new Set((await listAccountWorlds(token)).filter((w) => w.role === 'owner').map((w) => w.id));
        } catch {
            return false;
        }
        if (owned.size === 0) return false;
        const worlds = this.app.vault.getAbstractFileByPath(normalizePath('OnlyWorlds/Worlds'));
        if (!(worlds instanceof TFolder)) return false;
        for (const child of worlds.children) {
            if (!(child instanceof TFolder)) continue;
            const key = await worldFileApiKey(this.app, child.name);
            if (!key || !/^ow_w_/.test(key)) continue;
            try {
                const meta = await new V2Client(key, '').getWorld();
                if (!owned.has(String(meta.id))) continue;
            } catch {
                continue;
            }
            try {
                await new V2Client(key, pin).getWorld();
                return false;
            } catch (error) {
                return error instanceof V2ApiError && (error.status === 401 || error.status === 403);
            }
        }
        return false;
    }

    private async createWorldOnAccount(
        account: { token: string; username: string },
        worldData: WorldCreationData
    ): Promise<{ api_key: string; afterLanding?: () => Promise<void> } | null> {
        // The typed PIN is the one Take online uploads with. keel takes it at
        // create only from an account with no PIN yet, so a wrong PIN would
        // otherwise surface after the world exists, as an upload refused into
        // an empty world. Check it first where the vault can (Kael's review).
        if (worldData.pin && (await this.typedPinIsWrong(account.token, String(worldData.pin)))) {
            new ApiResponseModal(
                this.app,
                false,
                "That PIN is not your account's PIN, so nothing was created on onlyworlds.com. Type your account PIN and try again.",
                null,
                () => {},
                'World create failed'
            ).open();
            return null;
        }
        let created: CreatedWorld;
        try {
            created = await createAccountWorld(account.token, worldData.name, worldData.pin ? String(worldData.pin) : '');
        } catch (error) {
            new ApiResponseModal(
                this.app,
                false,
                error instanceof Error ? error.message : 'The world could not be created.',
                null,
                () => {},
                'World create failed'
            ).open();
            return null;
        }
        let minted;
        try {
            minted = await mintVaultKey(
                account.token,
                { id: created.id, name: created.name, role: 'owner' },
                this.app.vault.getName()
            );
        } catch (error) {
            if (isFullWriteKey(created.key)) {
                console.warn('OnlyWorlds: no key named for this vault could be made; using the key the world was created with.', error);
                new Notice(`World "${worldData.name}" created on onlyworlds.com under ${account.username}.`, 6000);
                return { api_key: created.key };
            }
            new ApiResponseModal(
                this.app,
                false,
                `World "${worldData.name}" was created on onlyworlds.com, but no key for this vault could be made: ` +
                    `${error instanceof Error ? error.message : String(error)}. Download it with Download world.`,
                null,
                () => {},
                'World create failed'
            ).open();
            return null;
        }
        const keepId = minted.id;
        new Notice(`World "${worldData.name}" created on onlyworlds.com under ${account.username}.`, 6000);
        return {
            api_key: minted.key,
            afterLanding: async () => {
                try {
                    await revokeCreateKeys(account.token, created, keepId);
                } catch (error) {
                    console.error('OnlyWorlds: the create key could not be revoked; revoke it on the account keys page.', error);
                    new Notice("The key the world was created with could not be revoked here; revoke it on onlyworlds.com, on the world's keys page.", 10000);
                }
            },
        };
    }

    async createLocalWorldFiles(worldName: string, worldData: any) {
        // Create base and subdirectories for the world. The folder is the
        // name's one safe path segment (Kael's review 3.7); World.md keeps the name.
        const worldBasePath = `OnlyWorlds/Worlds/${safeWorldFolderName(worldName)}`;
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
            time_range_max: 100,
            // World units (standard 00.31.00): "" = not set; the user fills them in World.md.
            length_unit: "",
            mass_unit: "",
            distance_unit: ""
        };
        
        let worldNoteContent = this.compileWorldNote(worldNoteData);
        // Local-only worlds: the how-to lives where the user will look for it.
        // (Prose below the field list is ignored by every World.md parser.)
        if (worldData.api_key === LOCAL_WORLD_KEY_TOKEN) {
            worldNoteContent +=
                `\n## Local-only world\n` +
                `This world lives entirely in your vault — nothing is sent to onlyworlds.com.\n\n` +
                `To take it online later, either:\n` +
                `- run **Create world** and use **Take online** (creates the world under your account and uploads your elements), or\n` +
                `- create a world at [onlyworlds.com](https://www.onlyworlds.com), then replace \`local\` in the API Key line above with its key and run **Upload world**.\n`;
        }
        await this.app.vault.create(`${worldBasePath}/World.md`, worldNoteContent);

        // Core files: the Readme and Settings notes.
        const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest);
        await createCoreFilesCommand.execute();

        // The world's Bases file (OW Infra #188), behind its setting.
        if (this.writeBases()) {
            await writeWorldBasesFileQuietly(this.app, safeWorldFolderName(worldName));
        }
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
