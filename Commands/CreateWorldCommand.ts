import { App, Notice, PluginManifest, TFolder, normalizePath } from 'obsidian';

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
import { CREATE_SIGN_IN_FIRST, createAccountWorld, isFullWriteKey, listAccountWorlds, mintVaultKey, revokeCreateKeys, vaultKeyName, type CreatedWorld } from '../account/account-api';
import { V2ApiError, V2Client } from '../client-v2';

export class CreateWorldCommand {
    app: App;
    manifest: PluginManifest;
    /** For the take-online flow: chained upload after linking (optional plumbing). */
    private exportCommand: ExportWorldCommand | null;

    /**
     * The signed-in account, or null. Create World online goes through the
     * account only (OW Infra #358; since 3.11 the only door, OW Obsidian #577:
     * keel #134 froze the old email-and-PIN route): signed out, the plugin
     * asks to sign in, or makes a local-only world.
     */
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

            new Notice('World created: ' + worldData.name);
        } catch (error) {
            console.error("Error during world creation:", error);
            new Notice('Could not create the world: ' + (error instanceof Error ? error.message : 'Unknown error'));
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

    async createWorldOnServer(worldData: WorldCreationData): Promise<{ api_key: string; afterLanding?: () => Promise<void> } | null> {
        const account = this.activeAccount();
        if (account) return this.createWorldOnAccount(account, worldData);
        new ApiResponseModal(this.app, false, CREATE_SIGN_IN_FIRST, null, () => {}, 'Sign in first').open();
        return null;
    }

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

    /**
     * Signed in: POST /api/v2/account/worlds through the SDK's
     * createAccountWorld (OW Obsidian #577), the PIN only if keel says the
     * account has none yet, the world's write key named for the vault as
     * Download World names its keys (`obsidian: <vault>`, Seethe's walk, h37
     * #6462), so the keys page holds one named key per vault. keel shows that
     * key once; it goes into World.md (the caller) and is shown nowhere else.
     * Should the answer carry no full key, the vault mints its own named key
     * (mintVaultKey) and `afterLanding`, called once that key is in World.md,
     * revokes the create route's key. Answers `{api_key}` so both callers go
     * on as before.
     */
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
            created = await createAccountWorld(
                account.token,
                worldData.name,
                worldData.pin ? String(worldData.pin) : '',
                vaultKeyName(this.app.vault.getName())
            );
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
        // The usual answer: the world's one key, named for this vault.
        if (isFullWriteKey(created.key)) {
            new Notice(`World "${worldData.name}" created on onlyworlds.com under ${account.username}.`, 6000);
            return { api_key: created.key };
        }
        let minted;
        try {
            minted = await mintVaultKey(
                account.token,
                { id: created.id, name: created.name, role: 'owner' },
                this.app.vault.getName()
            );
        } catch (error) {
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
