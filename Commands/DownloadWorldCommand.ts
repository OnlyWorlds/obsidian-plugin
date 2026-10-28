import Handlebars from 'handlebars';
import { WorldDownloadAccount, WorldDownloadData, WorldDownloadModal } from '../Modals/WorldDownloadModal';
import {
    AccountWorld,
    MintedKey,
    NO_PIN_YET,
    REVOKE_BY_HAND,
    canWrite,
    listAccountWorlds,
    mintVaultKey,
    mintWriteKey,
    revokeAccountKey,
} from '../account/account-api';
import { openSignIn } from '../account/sign-in';
import { LOCAL_WORLD_KEY_TOKEN, isReadKey, worldFileApiKey, writeWorldFileApiKey } from '../vault/world-key';
import { safeWorldFolderName } from '../vault/world-name';
import { App, normalizePath, Notice, TFile, TFolder } from 'obsidian';
import { worldTemplateString } from '../Scripts/WorldDataTemplate';
import { WorldService, isNoteNameFor, sanitizeFileName } from '../Scripts/WorldService';
import { Category } from '../enums';
import { V2ApiError, V2Change, V2Client, V2_ORIGIN } from '../client-v2';
import { recordServerWorldId } from '../vault/world-id-marker';
import { readFolderSidecar, writeFolderSidecar } from '../vault/folder-sidecar';
import { asChangeSeq, changeSeqOf, recordChangeSeqs } from '../vault/change-seq-index';
import type OnlyWorldsPlugin from '../main';
import { CreateCoreFilesCommand } from './CreateCoreFilesCommand';
import { parseElementPath, writeElement } from '../vault/element-file';
import { idsInFrontmatter, parseRawFrontmatterScalars } from '../vault/element-transform';
import { upsertWorldUnits, worldUnitsFromBody } from '../vault/world-units';
import { writeWorldBasesFileQuietly } from '../vault/bases-writer';
import { RENAME_START_NOTICE, plainFoldersNotice, renameCountedCategoryFolders } from '../vault/plain-folders';
import { keptDeleteCount } from '../sync/deleted-on-server';
import { hiddenNotices, planHidden, resyncReasonOf, stubNote, type ResyncReason } from '../sync/hidden-on-server';
import { isKnownOfElement, knownOfKeptText, knownOfNotices, knownOfWrite, nextLastKnown, noteStateOf, type NoteState } from '../sync/known-of';

export class DownloadWorldCommand {
    app: App;
    manifest: any;
    private worldService: WorldService;
    private plugin: OnlyWorldsPlugin | null;

    constructor(app: App, manifest: any, plugin?: OnlyWorldsPlugin) {
        this.app = app;
        this.manifest = manifest;
        this.plugin = plugin ?? null;
        this.worldService = new WorldService(app);
    }

    async execute(overwrite: boolean = false) {
        new WorldDownloadModal(this.app, async (data: WorldDownloadData | null) => {
            if (!data) {
                // User cancelled the operation
                return;
            }

            if (data.apiKey.trim().length > 0) {
                await this.downloadWithKey(data.apiKey, data.pin, overwrite);
            } else {
                new Notice('API key is required.');
            }
        }, this.accountChoice(), this.signInChoice(overwrite)).open();
    }

    /**
     * Signed out: the Download dialog's sign-in line. Once signed in, the
     * signed-out dialog closes and Download runs again, into the account's worlds.
     */
    private signInChoice(overwrite: boolean): ((signedIn: () => void) => void) | undefined {
        const plugin = this.plugin;
        if (!plugin || plugin.settings.accountToken) return undefined;
        return (closeDialog) => openSignIn(plugin, {
            then: () => {
                closeDialog();
                void this.execute(overwrite);
            },
        });
    }

    /**
     * Download one world with a key (and its PIN, or "" for none): the
     * key-and-PIN form's path, and the one an account world or a join link
     * takes once it holds its key. Returns the world's folder name, or null
     * when nothing landed (the reason is already said in a Notice).
     */
    async downloadWithKey(apiKeyInput: string, pin: string, overwrite: boolean = false): Promise<string | null> {
                try {
                    new Notice('Downloading world...');
                    const client = new V2Client(apiKeyInput.trim(), String(pin));

                    // World meta first — also validates the credential pair with a
                    // precise error before any element traffic.
                    const worldMeta = await client.getWorld();
                    const worldId = String(worldMeta.id ?? '');
                    const worldName = worldMeta.name ? String(worldMeta.name) : null;

                    if (!worldName) {
                        new Notice('No valid world data found.');
                        return null;
                    }

                    // Incremental pull when we hold a cursor for this world; a
                    // server rewind (head below our stored head) or a rejected
                    // cursor forces a cold re-walk from the epoch.
                    //
                    // Watermark vs vault reality (Titus's smoke, 2026-07-16):
                    // settings/data.json OUTLIVES vault content — after clearing
                    // the world folder, a stored cursor at head means "changes
                    // since" = zero, and Download honestly writes NOTHING into an
                    // empty vault. If the vault holds no element notes for this
                    // world, the cursor is stale state, not truth: ignore it and
                    // pull cold.
                    let stored = this.plugin?.settings.syncCursors?.[worldId];
                    if (stored && !this.vaultHasElementNotes(safeWorldFolderName(worldName))) {
                        console.log('OnlyWorlds: vault has no notes for this world — ignoring sync cursor, full download.');
                        stored = undefined;
                    }
                    // An install from before the list (a stored cursor, no
                    // knownOnServer entry for this world) walks the feed from
                    // the start once, for the list alone: nothing else of that
                    // walk is applied (Kael's read, 2026-10-20). A failed read
                    // leaves it for the next Download.
                    let storedKnown: string[] = this.plugin?.settings.knownOnServer?.[worldId] ?? [];
                    if (stored?.cursor && this.plugin && this.plugin.settings.knownOnServer?.[worldId] === undefined) {
                        try {
                            const full = await client.changesWalk();
                            storedKnown = [...planHidden({ latest: full.changes, fromStart: true, resync: null, ownIds: new Set() }).known];
                        } catch (e) {
                            console.warn('OnlyWorlds: could not read the feed to fill the known list; next Download tries again.', e);
                        }
                    }
                    let walk: { changes: V2Change[]; cursor: string | null; head: number };
                    // A walk from the start, and why: keel's 409 resync_required
                    // says `view` (drop what the walk no longer names), `role` or
                    // nothing (keep it): D127.
                    let fromStart = !stored?.cursor;
                    let resync: ResyncReason | null = null;
                    try {
                        walk = await client.changesWalk(stored?.cursor);
                        if (stored && walk.head < stored.head) {
                            walk = await client.changesWalk();
                            fromStart = true;
                        }
                    } catch (e) {
                        if (stored) {
                            resync = resyncReasonOf(e);
                            walk = await client.changesWalk();
                            fromStart = true;
                        } else {
                            throw e;
                        }
                    }

                    // Fold the change stream into per-category buckets. Changes
                    // arrive in sequence order, so later ops win per element id.
                    const latest = new Map<string, V2Change>();
                    for (const change of walk.changes) {
                        latest.set(change.id, change);
                    }
                    const worldData: Record<string, any> = {};
                    for (const change of latest.values()) {
                        if (change.op === 'delete') {
                            // Notes are never auto-deleted (a note may hold user
                            // prose beyond the element). The count of kept notes
                            // is surfaced below.
                            continue;
                        }
                        if (!change.element) continue;
                        const category = change.type.charAt(0).toUpperCase() + change.type.slice(1);
                        (worldData[category] ??= []).push(change.element);
                    }

                    // Template compatibility: the World.md template expects the
                    // v1 field names, and the API key comes from the user's input
                    // (v2 never echoes credentials).
                    worldData.World = {
                        ...worldMeta,
                        api_key: apiKeyInput.trim(),
                        time_current: worldMeta.time_range_current,
                    };
                    const worldApiKey = apiKeyInput.trim();
    
                    // Generate unique world name to prevent conflicts
                    const uniqueWorldName = await this.worldService.generateUniqueWorldName(worldName, worldApiKey);
               //     console.log(`[DownloadWorldCommand] Original world name: ${worldName}, Unique name: ${uniqueWorldName}`);
    
                    // Corrected paths to include OnlyWorlds/Worlds/{uniqueWorldName}/Elements
                    const worldFolderPath = normalizePath(`OnlyWorlds/Worlds/${uniqueWorldName}`);
                    const elementsFolderPath = normalizePath(`${worldFolderPath}/Elements`);
                    const fs = this.app.vault.adapter;
    
                    // Ensure the World and Elements folders exist
                    await this.createFolderIfNeeded(worldFolderPath);
                    await this.createFolderIfNeeded(elementsFolderPath);

                    // The type folders lose their count, once
                    // (the profile's `<Type>/<Name>.md`): `Location (2)` becomes
                    // `Location` through Obsidian's rename, so links are kept,
                    // before any note is written. A folder whose notes cannot
                    // move whole is left as it is and named in the notice.
                    // Said first, when there is a folder to rename: Obsidian's
                    // Update links prompt may hold the download (Seethe's walk).
                    const plainFolders = plainFoldersNotice(await renameCountedCategoryFolders(this.app, uniqueWorldName, {
                        onStart: () => new Notice(RENAME_START_NOTICE, 15000),
                    }));
                    if (plainFolders) new Notice(plainFolders, 15000);
    
                    // Generate world file
                    const worldFilePath = `${worldFolderPath}/World.md`;
                    if (overwrite || !await fs.exists(worldFilePath)) {
                        await this.generateWorldFile(worldData.World, worldFolderPath);
                    } else {
                        // An existing World.md keeps every line except the world
                        // units, which follow the server like element fields do
                        // (a World.md from before 00.31.00 gains a Units section).
                        await this.syncWorldUnits(worldFilePath, worldMeta);
                    }

                    // The server world this folder holds (3.8.0): its id in the
                    // folder's id marker, and GET /world's body as served in the
                    // folder sidecar, which the folder export reads (spec §4.1:
                    // a downloaded folder is that world, and a capture keeps
                    // every key the world carried).
                    await this.recordServerWorld(uniqueWorldName, worldMeta);

                    // Readme + Settings notes (writeElement builds the element notes).
                    const createCoreFilesCommand = new CreateCoreFilesCommand(this.app, this.manifest);
                    await createCoreFilesCommand.execute();

                    // Generate element notes in the correct category folders under Elements
                    // (Phase B: frontmatter via writeElement — no Handlebars templates)
                    const knownOf = await this.generateElementNotes(elementsFolderPath, worldData, overwrite, { resync });

                    // Each note this pull wrote now holds the server's copy at
                    // its feed row's change_seq: the number a save sends as
                    // If-Match. A delete row clears its id's.
                    const seqs: Record<string, number | null> = {};
                    for (const id of knownOf.landed) {
                        const row = latest.get(id);
                        seqs[id] = row ? asChangeSeq(row.change_seq) ?? changeSeqOf(row.element) : null;
                    }
                    for (const change of latest.values()) if (change.op === 'delete') seqs[change.id] = null;
                    await recordChangeSeqs(this.app, uniqueWorldName, seqs);

                    // The ids the feed reported deleted, old and new: a save never
                    // recreates them as link targets; a later upsert of an id
                    // clears it (Kael's read, blocker 1c). Only ids that still
                    // have a note here, or that a note here links to by id, are
                    // kept: the list guards kept notes and their links, and a
                    // full walk sees every delete the world ever had (Kael's
                    // third read, 4; the fix round, item 8). An empty list needs
                    // no read of every note (round C, 8).
                    // A hidden row is not a delete: its id goes on the hidden
                    // list instead, below.
                    const deleted = new Set(this.plugin?.settings.deletedOnServer?.[worldId] ?? []);
                    for (const change of latest.values()) {
                        if (change.op === 'delete' && change.reason !== 'hidden') deleted.add(change.id);
                        else deleted.delete(change.id);
                    }
                    const storedHidden = this.plugin?.settings.hiddenOnServer?.[worldId] ?? [];
                    const storedLeftView = this.plugin?.settings.leftView?.[worldId] ?? [];
                    const hiddenRow = [...latest.values()].some(c => c.op === 'delete' && c.reason === 'hidden');
                    const readNotes = deleted.size > 0 || storedHidden.length > 0 || storedLeftView.length > 0 || hiddenRow || resync !== null;
                    const { own, all: local, files } = readNotes ? await this.localElementIds(uniqueWorldName)
                        : { own: new Set<string>(), all: new Set<string>(), files: new Map<string, TFile>() };
                    // The notice counts only deletes that left a note of their
                    // own in this vault: a fresh vault's first download walks the
                    // world's whole history and meets deletes that never had a
                    // note here (Seethe, 3.5.1: "7 elements deleted" on an empty
                    // vault); a raw-id link to a deleted element is not a kept
                    // note (Kael's read, 2026-10-19).
                    const keptCount = keptDeleteCount(latest.values(), own);

                    // Hidden by the world's owner: a hidden row,
                    // or a view resync's walk not naming a note whose element
                    // this device knew on the server, makes that note a stub.
                    // Never a deleted file, never a note with no element id.
                    const hidden = planHidden({
                        latest: latest.values(),
                        storedHidden,
                        storedKnown,
                        storedLeftView,
                        fromStart,
                        resync,
                        ownIds: own,
                    });
                    const hiddenCount = await this.stubNotes(hidden.stubHidden, files);
                    const viewCount = await this.stubNotes(hidden.stubView, files);

                    // Persist the watermark only after every note landed — a
                    // failed run must re-pull the same changes next time.
                    if (this.plugin && walk.cursor) {
                        this.plugin.settings.syncCursors[worldId] = { cursor: walk.cursor, head: walk.head };
                        this.plugin.settings.deletedOnServer = {
                            ...(this.plugin.settings.deletedOnServer ?? {}),
                            [worldId]: [...deleted].filter(id => local.has(id)),
                        };
                        this.plugin.settings.hiddenOnServer = {
                            ...(this.plugin.settings.hiddenOnServer ?? {}),
                            [worldId]: [...hidden.hidden].filter(id => local.has(id)),
                        };
                        this.plugin.settings.knownOnServer = {
                            ...(this.plugin.settings.knownOnServer ?? {}),
                            [worldId]: [...hidden.known],
                        };
                        // A role (or no-reason) reset's kept notes: never sent
                        // again until the feed names them (Kael's read, 2026-10-20).
                        this.plugin.settings.leftView = {
                            ...(this.plugin.settings.leftView ?? {}),
                            [worldId]: [...hidden.leftView].filter(id => local.has(id)),
                        };
                        // Whole notes kept over a stub: never sent while keel
                        // serves a stub for them.
                        this.plugin.settings.lastKnown = {
                            ...(this.plugin.settings.lastKnown ?? {}),
                            [worldId]: nextLastKnown(this.plugin.settings.lastKnown?.[worldId] ?? [], knownOf.kept, knownOf.written),
                        };
                        await this.plugin.saveSettings();
                    }

                    const changedNote = stored ? ` (${latest.size} changed element${latest.size === 1 ? '' : 's'})` : '';
                    new Notice(`World downloaded: ${uniqueWorldName}${changedNote}`);
                    if (keptCount > 0) {
                        new Notice(`${keptCount} element${keptCount === 1 ? '' : 's'} deleted on the server — their notes were kept. Remove them manually if desired.`, 10000);
                    }
                    for (const line of hiddenNotices(hiddenCount, viewCount)) new Notice(line, 10000);
                    for (const line of knownOfNotices(knownOf.became, knownOf.keptWhole)) new Notice(line, 10000);

                    // The world's Bases file (a table and cards per type),
                    // behind its setting; never fails the download. After the
                    // download's own notices, so its once-per-vault notice reads
                    // as the footnote it is (Seethe, 3.5.1).
                    if (this.plugin?.settings.writeBasesFile !== false) {
                        await writeWorldBasesFileQuietly(this.app, uniqueWorldName, this.plugin ?? undefined);
                    }
                    return uniqueWorldName;
                } catch (error) {
                    console.error('Error during world download:', error);
                    if (error instanceof V2ApiError) {
                        if (error.status === 401 || error.status === 403) {
                            new Notice('Download failed: Invalid PIN or API key.');
                        } else if (error.status === 429) {
                            new Notice('Download failed: rate limit exceeded. Try again later.');
                        } else {
                            new Notice(`Download failed: ${error.message}`, 10000);
                        }
                    } else if (error instanceof Error) {
                        new Notice(`Error fetching world data: ${error.message}`);
                    } else {
                        new Notice('An unknown error occurred during download.');
                    }
                }
                return null;
    }

    /** The account choice the Download World modal offers, when this vault is signed in. */
    private accountChoice(): WorldDownloadAccount | undefined {
        const token = this.plugin?.settings.accountToken;
        if (!token) return undefined;
        return {
            username: this.plugin?.settings.accountUsername || 'your account',
            loadWorlds: () => listAccountWorlds(token),
            onPick: (w) => { void this.downloadAccountWorld(w); },
        };
    }

    /**
     * Download a world from the signed-in account. A world this
     * vault already holds under one of its live keys downloads again with that
     * key; otherwise a key is minted for this vault (named for it, so it can be
     * found and revoked on the account's keys page) and the world downloads
     * with it, the key landing in World.md like a pasted one. Downloading is a
     * read: no PIN is asked or sent; Save Element asks for it as it always has.
     */
    async downloadAccountWorld(world: AccountWorld): Promise<string | null> {
        const token = this.plugin?.settings.accountToken;
        if (!token) {
            new Notice('Sign in first: Settings, OnlyWorlds account.');
            return null;
        }
        const held = await this.heldKeyFor(world);
        if (held) {
            // A read key held by a role that can write (read for want of a PIN,
            // earlier): the advice was "set a PIN, then download again to
            // write", so this download upgrades it (Kael's review 3.2).
            if (isReadKey(held.key) && canWrite(world)) {
                const upgraded = await this.upgradeToWriteKey(token, world, held);
                return this.downloadWithKey(upgraded ?? held.key, '');
            }
            return this.downloadWithKey(held.key, '');
        }

        let minted: MintedKey;
        try {
            minted = await mintVaultKey(token, world, this.app.vault.getName());
        } catch (error) {
            new Notice(`Download failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
            return null;
        }
        if (minted.readForWantOfPin) new Notice(NO_PIN_YET, 10000);
        const landed = await this.downloadWithKey(minted.key, '');
        if (!landed) {
            // Nothing landed, so no World.md holds the new key: revoke it rather
            // than leave a live key no vault keeps (Kael's review).
            try {
                await revokeAccountKey(token, world.id, { id: minted.id, last4: minted.key.slice(-4), scope: minted.scope });
            } catch {
                new Notice(`The key made for ${world.name} could not be revoked from here: revoke it on onlyworlds.com, on the world's keys page.`, 10000);
            }
        }
        return landed;
    }

    /**
     * Mint a write key for a world this vault holds under a read key, put it in
     * that world's World.md in place of the read key, then revoke the read key
     * (best effort: a failure says to revoke it on onlyworlds.com). Returns the
     * new key, or null when keel still refuses a write key (no account PIN yet)
     * or World.md could not take it; the read key then stays as it was.
     */
    private async upgradeToWriteKey(token: string, world: AccountWorld, held: { key: string; folder: string }): Promise<string | null> {
        let minted: MintedKey | null;
        try {
            minted = await mintWriteKey(token, world, this.app.vault.getName());
        } catch (error) {
            new Notice(`No write key for ${world.name}: ${error instanceof Error ? error.message : String(error)}`, 10000);
            return null;
        }
        if (!minted) {
            new Notice(NO_PIN_YET, 10000);
            return null;
        }
        if (!(await writeWorldFileApiKey(this.app, held.folder, minted.key))) {
            // Nowhere to keep it: do not leave a live key no vault holds.
            try {
                await revokeAccountKey(token, world.id, { id: minted.id, last4: minted.key.slice(-4), scope: 'write' });
            } catch {
                /* the new key is named for this vault on the account's keys page */
            }
            return null;
        }
        try {
            await revokeAccountKey(token, world.id, { last4: held.key.slice(-4), scope: 'read' }, minted.id);
        } catch {
            new Notice(REVOKE_BY_HAND(world.name), 10000);
        }
        new Notice(`${world.name} can now be written from this vault.`);
        return minted.key;
    }

    /**
     * The key and folder of `world` if this vault already holds it: any key in
     * a World.md (prefixed, legacy 10-digit, one the account does not list, a
     * player link's) whose PIN-less GET /world answers with `world`'s id.
     * Identity is the world id, never the key's shape or its last four (Kael's
     * review 3.4: a legacy or unlisted key missed the last-four pre-filter and
     * the world came down again as "Name (1)"). A legacy key on a private world
     * needs its PIN even to read, so it cannot be recognised here; nothing is
     * asked for it.
     */
    private async heldKeyFor(world: AccountWorld): Promise<{ key: string; folder: string } | null> {
        const worlds = this.app.vault.getAbstractFileByPath(normalizePath('OnlyWorlds/Worlds'));
        if (!(worlds instanceof TFolder)) return null;
        for (const child of worlds.children) {
            if (!(child instanceof TFolder)) continue;
            const key = await worldFileApiKey(this.app, child.name);
            if (!key || key.toLowerCase() === LOCAL_WORLD_KEY_TOKEN) continue;
            try {
                const meta = await new V2Client(key, '').getWorld();
                if (meta.id === world.id) return { key, folder: child.name };
            } catch {
                // a key keel does not open without more: not recognisable here
            }
        }
        return null;
    }

    async createFolderIfNeeded(folderPath: string) {
        const normalizedPath = normalizePath(folderPath);
        let existingFolder = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!existingFolder) {
            try {
                await this.app.vault.createFolder(normalizedPath);  
            } catch (error) {
                console.error(`Error creating folder: ${normalizedPath}`, error);
            }
        }
    }
    
    async generateWorldFile(worldData: any, worldFolderPath: string) {
        const fs = this.app.vault.adapter;
        
        // Add image_display field based on image_url
        if (worldData.image_url) {
            worldData.image_display = `![World Image](${worldData.image_url})`;
        } else {
            worldData.image_display = "None";
        }
        
        // noEscape: note bodies are span-tag markdown, not HTML — field values
        // are plain data. Default escaping turned "The Kid's Family" into
        // "The Kid&#x27;s Family" on disk, which then failed file lookups and
        // uploaded escaped names verbatim.
        const worldTemplate = Handlebars.compile(worldTemplateString, { noEscape: true });
        const worldContent = worldTemplate(worldData);
        const worldFilePath = `${worldFolderPath}/World.md`;
        await fs.write(worldFilePath, worldContent); 
    }
    /**
     * Record the server world in the world's folder: the id marker takes the
     * server id, the sidecar's `server` block the world body (never a key: v2
     * does not echo one, and `api_key` is dropped if it ever did). Never fails
     * the download; a failure is logged and the export then mints, saying so.
     */
    private async recordServerWorld(worldName: string, worldMeta: Record<string, unknown>): Promise<void> {
        const id = typeof worldMeta.id === 'string' ? worldMeta.id : '';
        if (!id) return;
        try {
            await recordServerWorldId(this.app, worldName, id);
            const world: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(worldMeta)) if (k !== 'api_key' && k !== 'api') world[k] = v;
            const sidecar = await readFolderSidecar(this.app, worldName);
            sidecar.server = { server: V2_ORIGIN, world };
            await writeFolderSidecar(this.app, worldName, sidecar);
        } catch (error) {
            console.error('OnlyWorlds: could not record the server world for the folder export', error);
        }
    }

    /** Write the server's world units into an existing World.md (only when they differ). */
    private async syncWorldUnits(worldFilePath: string, worldMeta: Record<string, unknown>): Promise<void> {
        const units = worldUnitsFromBody(worldMeta);
        if (Object.keys(units).length === 0) return; // server without units: leave World.md alone
        const fs = this.app.vault.adapter;
        try {
            const current = await fs.read(worldFilePath);
            const next = upsertWorldUnits(current, units);
            if (next !== current) await fs.write(worldFilePath, next);
        } catch (error) {
            console.error('OnlyWorlds: could not update the world units in World.md', error);
        }
    }

    /**
     * Write the pulled elements' notes. `resync` is the reason of the 409 that
     * forced this walk from the start, if any: a known-of stub replaces a whole
     * note only after a `view` reset (the folder spec §4.4 rule 5).
     * Returns how many notes became known of, the ids of whole notes
     * kept as last known, and the ids written.
     */
    async generateElementNotes(
        worldFolderPath: string,
        data: any,
        overwrite: boolean,
        opts: { resync?: ResyncReason | null } = {}
    ): Promise<{ became: number; keptWhole: number; kept: string[]; written: string[]; landed: string[] }> {
        const fs = this.app.vault.adapter;
        let became = 0;
        let keptWhole = 0;
        const kept: string[] = [];

        // Extract the (unique) world name once — used both for the id->name map's
        // disk fallback and per-category below.
        const pathParts0 = worldFolderPath.split('/');
        const worldsIdx0 = pathParts0.findIndex(part => part === 'Worlds');
        const worldName = worldsIdx0 >= 0 && pathParts0.length > worldsIdx0 + 1
            ? pathParts0[worldsIdx0 + 1]
            : pathParts0[pathParts0.length - 1];

        // Pass 1 — PLAN every element's note path before writing any note.
        //
        // ★ A link must name the note it points at. Two elements of one type
        // sharing a name get `Twin.md` and `Twin (1).md`; the link to the second
        // must read `[[Twin (1)]]`, or Obsidian (and the upload) resolve it to
        // the first. The paths are decided here,
        // twins in the same pull kept apart by `planned`, so the id -> note-name
        // map below knows every note's real filename before the first link is
        // written.
        const plans: {
            category: string;
            categoryDirectory: string;
            element: any;
            existingElementPath: string | null;
            renameFrom: string | null;
            notePath: string;
            /** Written as a known-of stub (rule 1). */
            knownOf: boolean;
        }[] = [];
        const planned = new Set<string>(); // lowercased note paths claimed in this pull

        for (const category in Category) {
            if (!isNaN(Number(category)) || !data[category]) continue;

            const elements = data[category];

            // The type's folder, `<Type>` (made when the world has none). A new
            // note lands there; a note this element already has is found by id
            // in every folder of the type, so one left in a counted folder the
            // rename could not merge is updated where it is, never doubled.
            const typeFolders = await this.worldService.findCategoryFolders(worldName, category);
            let categoryDirectory: string;

            if (typeFolders.length > 0) {
                categoryDirectory = typeFolders[0].path;
            } else {
                categoryDirectory = normalizePath(`${worldFolderPath}/${category}`);
                await this.createFolderIfNeeded(categoryDirectory);
            }
            const searchFolders = typeFolders.length > 0 ? typeFolders.map((f) => f.path) : [categoryDirectory];

            for (const element of elements) {
                // First check if an element with this ID already exists
                let existingElementPath: string | null = null;
                for (const folder of searchFolders) {
                    existingElementPath = await this.findElementByIdInCategory(folder, element.id);
                    if (existingElementPath) break;
                }
                // A known-of stub (the folder spec §4.4): written
                // as it is over no note, a known-of note or a hidden stub; over
                // a whole note only after a view reset, else that note is kept
                // as last known (Titus's B12 ruling).
                let knownOf = false;
                if (isKnownOfElement(element)) {
                    let state: NoteState = 'none';
                    if (existingElementPath) {
                        const current = this.app.vault.getAbstractFileByPath(existingElementPath);
                        try {
                            state = current instanceof TFile ? noteStateOf(await this.app.vault.read(current)) : 'none';
                        } catch {
                            state = 'whole'; // unreadable: never overwritten by a stub
                        }
                    }
                    const write = knownOfWrite(element, state, opts.resync ?? null);
                    if (write === 'keep') {
                        keptWhole++;
                        kept.push(String((element as { id?: unknown }).id));
                        continue;
                    }
                    knownOf = true;
                    if (state !== 'known_of') became++;
                }
                let notePath: string;
                let renameFrom: string | null = null;

                if (existingElementPath) {
                    // Element already exists (found by its id): it keeps its
                    // note while the file carries a name this element may
                    // have (WorldService.isNoteNameFor: its name, a twin's
                    // `Name (N)`, the id forms). A nameless note from before
                    // 3.8.0 (`unnamed (N)`) moves once to `<Type> <id tail>`.
                    const currentFileName = (existingElementPath.split('/').pop() ?? '').replace(/\.md$/i, '');

                    if (!isNoteNameFor(currentFileName, element.name, String(element.id), category)) {
                        // Name has changed: the note moves to a fresh unique name (pass 2 renames it)
                        const newFileName = await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id, planned);
                        notePath = `${categoryDirectory}/${newFileName}`;
                        renameFrom = existingElementPath;
                    } else {
                        notePath = existingElementPath;
                    }
                } else {
                    // Generate unique filename for new element
                    const uniqueFileName = await this.worldService.generateUniqueFileName(categoryDirectory, element.name, element.id, planned);
                    notePath = `${categoryDirectory}/${uniqueFileName}`;
                }
                planned.add(notePath.toLowerCase());
                plans.push({ category, categoryDirectory, element, existingElementPath, renameFrom, notePath, knownOf });
            }
        }

        // Build ONE complete id->name map for link rendering (the S9 fix). Built
        // from the plan (every pulled element's real note name) + a raw-disk
        // fallback for ids outside an incremental pull's changed set.
        // metadataCache is NOT consulted — its staleness mid-bulk-write IS the bug.
        const { toName: idToName, toRealName: idToRealName } = await this.buildIdToNameMap(worldName, plans);

        // Pass 2 — rename and write. `landed`: the ids whose note this pull wrote.
        const landed: string[] = [];
        for (const plan of plans) {
            const { category, element, existingElementPath } = plan;
            let notePath = plan.notePath;

            if (plan.renameFrom) {
                try {
                    const existingFile = this.app.vault.getAbstractFileByPath(plan.renameFrom);
                    if (existingFile) {
                        await this.app.fileManager.renameFile(existingFile, notePath);
                    } else {
                        notePath = plan.renameFrom;
                    }
                } catch (error) {
                    console.error(`[DownloadWorldCommand] Error renaming file: ${error}`);
                    notePath = plan.renameFrom; // Fall back to existing path
                }
            }

            if (overwrite || existingElementPath || !await fs.exists(notePath)) {
                landed.push(String((element as { id?: unknown }).id));
                // A stub written in full again (an unhide, or back in view)
                // keeps the person's writing it held, above the first field, byte
                // for byte (Kael's read, 2026-10-20); so does a known-of note,
                // written again or whole.
                let keepAbove = '';
                if (existingElementPath) {
                    const current = this.app.vault.getAbstractFileByPath(notePath);
                    if (current instanceof TFile) {
                        try {
                            keepAbove = knownOfKeptText(await this.app.vault.read(current));
                        } catch { /* unreadable: written as any note */ }
                    }
                }
                // v2 frontmatter format (Phase B). writeElement owns the file
                // placement (it re-finds by embedded id), preserves extension
                // fields verbatim, normalizes link ids, and maps the body to
                // description (or story for Narrative). The raw v2 element body
                // (bare link ids, extension namespaces intact) goes straight in.
                await writeElement(
                    this.app,
                    worldName,
                    category,
                    element.id,
                    element,
                    {
                        markSelfWrite: (p) => this.plugin?.autoSync?.markSelfWrite(p),
                        // The folder the note is in (a kept note may sit in a
                        // counted folder the rename left), never another.
                        folderPath: notePath.slice(0, notePath.lastIndexOf('/')),
                        fileName: notePath.split('/').pop(),
                        idToName,
                        idToRealName,
                        // A downloaded note carries the SAME full field set as a
                        // created one. Without this the note shows only fields
                        // that happen to hold values, so a sparse element gives
                        // the user no way to see what else it could carry —
                        // exactly the "kinda useless" problem 3.2 exists to fix.
                        scaffoldEmptyFields: true,
                        keepAbove,
                        knownOf: plan.knownOf,
                    }
                );
            }
        }
        return { became, keptWhole, kept, written: plans.map((p) => String((p.element as { id?: unknown }).id)), landed };
    }

    /**
     * Build the id -> note-name map used to render link fields as [[Name]]
     * wikilinks during download (the S9 fix). Two sources, the plan wins:
     *
     *   1. The download plan — every pulled element's note path, decided before
     *      any note is written. The name is that note's BASENAME, so a twin's
     *      link reads `[[Twin (1)]]`, not `[[Twin]]`.
     *   2. Raw-disk fallback — an incremental pull carries only CHANGED elements,
     *      so a link may point at an unchanged element absent from the payload.
     *      Scan existing element notes for this world by READING each file for
     *      its `id`; the name is the note's own basename. metadataCache is never
     *      touched: its cold-cache-mid-write staleness is precisely the bug.
     *
     * A basename resolves by filename (portability: a moved vault keeps working,
     * no plugin needed). An id in neither source returns null, so writeElement
     * keeps the raw id (dangling / cross-world links are never lost).
     *
     * Same basename in two TYPES (a Location and a Collective both named
     * Syracuse): both notes are `Syracuse.md` in different folders and the link
     * stays plain `[[Syracuse]]` (ruling). Upload resolves a link FIELD against
     * notes of its target type only (element-file.ts buildWikilinkResolver).
     */
    private async buildIdToNameMap(
        worldName: string,
        plans: { element: any; notePath: string }[]
    ): Promise<{ toName: (id: string) => string | null; toRealName: (id: string) => string | null }> {
        const map = new Map<string, string>();
        // The element's own name beside its note's name: a `### Depends on`
        // line shows it where the two differ (a name a file name cannot hold).
        const real = new Map<string, string>();
        const basename = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

        // Source 2 (disk) first, so Source 1 (the plan) overwrites on any id
        // present in both.
        const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
        const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(prefix));
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const fm = parseRawFrontmatterScalars(content, ['id', 'name']);
                if (fm.id) {
                    map.set(fm.id, file.basename);
                    if (fm.name) real.set(fm.id, fm.name);
                    else real.delete(fm.id);
                }
            } catch { /* unreadable note — skip */ }
        }

        // Source 1 (the plan) — every downloaded element, all categories.
        for (const plan of plans) {
            const element = plan.element;
            if (element && typeof element.id === 'string') {
                map.set(element.id, basename(plan.notePath));
                if (typeof element.name === 'string' && element.name) real.set(element.id, element.name);
                else real.delete(element.id);
            }
        }

        return { toName: (id: string) => map.get(id) ?? null, toRealName: (id: string) => real.get(id) ?? null };
    }

    async linkifyContent(noteContent: string, data: any): Promise<string> {
        // Incremental pulls carry only CHANGED elements, so the pulled data
        // alone can't name every linked id — merge in an id→name index built
        // from the vault's existing notes (2.3.0 smoke test: ids outside the
        // pull window rendered as [[Unknown]], losing the id entirely).
        const vaultIndex = await this.buildVaultNameIndex();
        noteContent = noteContent.replace(/\[\[(.*?)\]\]/g, (match, id) => {
            const name = this.findNameById(id, data) ?? vaultIndex.get(id);
            // Wikilink targets are FILENAMES — sanitize so links to elements
            // with ':' etc. in their names resolve (the note's Name field and
            // the API keep the exact name; only the link/file form changes).
            // Never write [[Unknown]]: an unresolvable id stays as [[<id>]] so
            // identity survives and export can pass it through.
            return name ? `[[${sanitizeFileName(name)}]]` : `[[${id}]]`;
        });

        return noteContent;
    }

    /**
     * Each note's stub (sync/hidden-on-server.ts), written through the one
     * write (one read, one vault.modify, the frontmatter at byte 0). A note
     * already a stub, or with no frontmatter id (a legacy span note), is left
     * as it is. Returns how many notes changed.
     */
    private async stubNotes(ids: string[], files: Map<string, TFile>): Promise<number> {
        let n = 0;
        for (const id of ids) {
            const file = files.get(id);
            const category = file ? parseElementPath(file.path)?.category : undefined;
            if (!file || !category) continue;
            try {
                const content = await this.app.vault.read(file);
                const next = stubNote(content, category);
                if (next === content) continue;
                this.plugin?.autoSync?.markSelfWrite(file.path);
                await this.app.vault.modify(file, next);
                n++;
            } catch (error) {
                console.error(`OnlyWorlds: could not stub the hidden element's note ${file.path}`, error);
            }
        }
        return n;
    }

    /** The element ids this world's notes carry, read from disk (the cache is cold mid-download):
     *  `own` the notes' own ids; `all` those plus every id a note's Properties link to;
     *  `files` each own id's note. */
    private async localElementIds(worldName: string): Promise<{ own: Set<string>; all: Set<string>; files: Map<string, TFile> }> {
        const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
        const own = new Set<string>();
        const all = new Set<string>();
        const files = new Map<string, TFile>();
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (!file.path.startsWith(prefix)) continue;
            try {
                const content = await this.app.vault.read(file);
                const id = parseRawFrontmatterScalars(content, ['id']).id;
                if (id) { own.add(id); all.add(id); if (!files.has(id)) files.set(id, file); }
                // The ids its Properties hold (a raw-id link to an element
                // with no note here): the deleted list keeps those too, so a
                // save leaves the link out (the fix round, item 8).
                for (const linked of idsInFrontmatter(content)) all.add(linked);
            } catch { /* unreadable note — skip */ }
        }
        return { own, all, files };
    }

    /** Does the vault hold ANY element note for this world? Used to sanity-check
     *  the sync-cursor watermark against vault reality: settings outlive vault
     *  content, and a stored cursor over an empty world folder means an
     *  incremental download would truthfully write nothing (2026-07-16 smoke). */
    private vaultHasElementNotes(worldName: string): boolean {
        const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
        return this.app.vault.getMarkdownFiles().some(f => f.path.startsWith(prefix));
    }

    /** id→name across every element note in the vault (all worlds' notes are
     *  under OnlyWorlds/Worlds/<w>/Elements/; ids are unique across worlds). */
    private async buildVaultNameIndex(): Promise<Map<string, string>> {
        const index = new Map<string, string>();
        const files = this.app.vault.getFiles().filter(f =>
            f.path.startsWith('OnlyWorlds/Worlds/') && f.path.includes('/Elements/') && f.extension === 'md');
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const idMatch = content.match(/>Id<\/span>:\s*(\S+)/);
                const nameMatch = content.match(/>Name<\/span>:\s*(.+)$/m);
                if (idMatch && nameMatch) {
                    index.set(idMatch[1].trim(), nameMatch[1].trim());
                }
            } catch { /* unreadable note — skip */ }
        }
        return index;
    }
    
    findNameById(id: string, data: any): string | undefined { 
        for (const category in Category) {
            if (Array.isArray(data[category])) {
                const found = data[category].find((item: any) => item.id === id);
                if (found) { 
                    return found.name;
                }
            }
        } 
        return undefined; // Return undefined if no match is found
    }

    async findElementByIdInCategory(categoryDirectory: string, elementId: string): Promise<string | null> {
     //   console.log(`[DownloadWorldCommand] Looking for element ID ${elementId} in directory: ${categoryDirectory}`);
        
        const categoryFolder = this.app.vault.getAbstractFileByPath(categoryDirectory);
        
        if (!(categoryFolder instanceof TFolder)) {
          //  console.log(`[DownloadWorldCommand] Category folder not found or not a folder: ${categoryDirectory}`);
            return null;
        }

     //   console.log(`[DownloadWorldCommand] Found ${categoryFolder.children.length} files in category folder`);

        for (const child of categoryFolder.children) {
            if (child instanceof TFile && child.extension === 'md') {
             //   console.log(`[DownloadWorldCommand] Checking file: ${child.path}`);
                try {
                    const content = await this.app.vault.read(child);
                  //  console.log(`[DownloadWorldCommand] File content preview (first 200 chars): ${content.substring(0, 200)}`);
                    
                    // Match the id in either format: frontmatter `id:` (3.0.0)
                    // first, then the legacy span/bold forms. Without the
                    // frontmatter form, a re-download never matches an existing
                    // migrated note here, so its rename branch can't fire (stale
                    // filename after a server rename). writeElement still redirects
                    // the write by embedded id, so no dup/loss — but match it.
                    const idMatch = content.match(/^id:\s*(\S+)/m) ||
                                  content.match(/^- \*\*ID:\*\* (.+)$/m) ||
                                  content.match(/^- .*Id.*: (.+)$/m) ||
                                  content.match(/Id.*: (.+)$/m);
                    
                    if (idMatch) {
                     //   console.log(`[DownloadWorldCommand] Found ID in file ${child.path}: ${idMatch[1].trim()}`);
                        if (idMatch[1].trim() === elementId) {
                         //   console.log(`[DownloadWorldCommand] MATCH! Found existing element at: ${child.path}`);
                            return child.path;
                        }
                    } else {
                    //    console.log(`[DownloadWorldCommand] No ID found in file: ${child.path}`);
                    }
                } catch (error) {
                    console.error(`Error reading element file: ${child.path}`, error);
                }
            }
        }
        
       // console.log(`[DownloadWorldCommand] No existing element found for ID: ${elementId}`);
        return null;
    }
}
