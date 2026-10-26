import { ValidateExportResultModal } from '../Modals/ValidateExportResultModal';
import { WorldPinSelectionModal } from '../Modals/WorldPinSelectionModal';
import { App, normalizePath, Notice, PluginManifest, TFile } from 'obsidian';
import { WorldService, sanitizeFileName } from '../Scripts/WorldService';
import { Category } from '../enums';
import { ValidateWorldCommand } from './ValidateWorldCommand';
import { decodeHtmlEntities } from '../Scripts/htmlEntities';
import { isStaleWrite, toV2Payload, V2ApiError, V2Client } from '../client-v2';
import { changeSeqOf, readChangeSeqIndex, recordChangeSeqs } from '../vault/change-seq-index';
import { staleUploadMessage } from '../sync/stale-save';
import { LOCAL_WORLD_SYNC_MESSAGE, READ_ONLY_WORLD_MESSAGE, resolveWorldKey, splitWorldsByWrite } from '../vault/world-key';
import { readElement, unclosedFenceMessage } from '../vault/element-file';
import { isSpanFormat, parseRawFrontmatterScalars, splitNote } from '../vault/element-transform';
import { parseWorldUnits, pushWorldUnits, WORLD_UNIT_FIELDS, WorldUnits } from '../vault/world-units';
import type OnlyWorldsPlugin from '../main';
import { ambiguousLinksMessage, withoutLinks } from './SaveElementCommand';
import { confirm } from '../Modals/ConfirmModal';
import { forgetDeleted } from '../sync/deleted-on-server';
import { isStubNote } from '../sync/hidden-on-server';
import { isKnownOfNote, isLastKnownId } from '../sync/known-of';
import { isInCategoryFolder } from '../vault/category-folder';

/** An element id as a link value holds it. */
const ELEMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ExportWorldCommand {
    app: App;
    manifest: PluginManifest;
    worldService: WorldService;
    plugin: OnlyWorldsPlugin | null;
    /** Link fields omitted from the current sweep because a link couldn't be
     *  resolved locally (server values preserved) — surfaced in the summary. */
    private skippedLinkFields = 0;
    /** Generic-link names left out because they match several types (row 2). */
    private ambiguousLinks: string[] = [];
    /** Notes this sweep does not send whole (an unclosed code fence), each with why (round C, 1). */
    private refusedNotes: string[] = [];
    /** Notes whose `### Depends on` holds lines a person wrote: kept in the note, never sent, named in the summary. */
    private dependsOnKept: string[] = [];
    /** The ids of this sweep's stubs: notes of elements hidden by the world's owner, never sent. */
    private stubIds = new Set<string>();
    /** Each stub's `Type "note name"`, to name a link left out to it. */
    private stubNames = new Map<string, string>();
    /** The ids of this sweep's known-of notes: never sent. */
    private knownOfIds = new Set<string>();
    /** Each known-of note's `Type "note name"`, to name a link left out to it. */
    private knownOfNames = new Map<string, string>();

    constructor(app: App, manifest: PluginManifest, worldService: WorldService, plugin?: OnlyWorldsPlugin) {
        this.app = app;
        this.manifest = manifest;
        this.worldService = worldService;
        this.plugin = plugin ?? null;
    }

    async execute() {
        const activeWorldName = await this.worldService.getWorldName(); // Fetch the active world name

        // A read-key world can never upload: say so before any PIN is asked
        // (Kael's review 3.1). A world picked in the modal is checked again in
        // the upload itself.
        if (activeWorldName && (await resolveWorldKey(this.app, activeWorldName, this.plugin?.settings.apiKey)).readOnly) {
            new Notice(READ_ONLY_WORLD_MESSAGE, 8000);
            return;
        }

        // The picker offers only worlds this vault can write to, and a vault
        // whose every world is read-only is refused here, before any PIN or
        // dialog (Kael's cold read, 2026-10-17). Same split as Rename World.
        const { writable, readOnly } = await splitWorldsByWrite(this.app, this.plugin?.settings.apiKey);
        if (writable.length === 0 && readOnly.length > 0) {
            new Notice(READ_ONLY_WORLD_MESSAGE, 8000);
            return;
        }

        // If a PIN is cached/persisted AND we have an active world, skip the picker.
        const cachedPin = this.plugin ? await this.plugin.pinCache.get() : null;
        if (cachedPin && activeWorldName) {
            const pinNum = parseInt(cachedPin, 10);
            if (!isNaN(pinNum)) {
                await this.runExport(pinNum, activeWorldName);
                return;
            }
        }

        const picker = new WorldPinSelectionModal(this.app, async (pin: number, worldFolder: string) => {
            await this.runExport(pin, worldFolder);
        }, activeWorldName);
        picker.worlds = writable;
        picker.readOnlyLeftOut = readOnly.length > 0;
        picker.open();
    }

    /** Validate a world and, on errors, show them. Returns true when clean.
     *  Lets the take-online flow gate BEFORE creating anything server-side. */
    async validateFor(worldFolder: string): Promise<boolean> {
        const validator = new ValidateWorldCommand(this.app, this.manifest, this.worldService, false);
        await validator.execute(worldFolder);
        if (validator.errorCount > 0) {
            new ValidateExportResultModal(this.app, validator.errors, validator.elementCount, validator.errorCount, worldFolder).open();
            return false;
        }
        return true;
    }

    /** Public entry with a known PIN + world — used by the take-a-local-world-online
     *  flow to chain the upload right after linking. skipPreview uploads directly
     *  after a silent re-validation: the user already confirmed via TAKE ONLINE,
     *  and the preview's overwrite warning is meaningless for a just-born world. */
    async executeFor(pin: number, worldFolder: string, opts?: { skipPreview?: boolean }): Promise<void> {
        if (opts?.skipPreview) {
            if (!(await this.validateFor(worldFolder))) return;
            const worldData = await this.collectWorldData(worldFolder);
            if (!worldData || Object.keys(worldData).length === 0) return;
            await this.uploadViaV2(pin, worldFolder, worldData);
            return;
        }
        await this.runExport(pin, worldFolder);
    }

    private async runExport(pin: number, worldFolder: string): Promise<void> {
        const validator = new ValidateWorldCommand(this.app, this.manifest, this.worldService, false);
        await validator.execute(worldFolder);

        const validationModal = new ValidateExportResultModal(this.app, validator.errors, validator.elementCount, validator.errorCount, worldFolder);

        validationModal.setExportCallback(async () => {
            if (validator.errorCount === 0) {
                const worldData = await this.collectWorldData(worldFolder);
                if (!worldData || Object.keys(worldData).length === 0) return;
                await this.uploadViaV2(pin, worldFolder, worldData);
            }
        });

        validationModal.open();
    }

    /**
     * v2 upload sweep (replaces the legacy worldsync/store full-replace).
     * Per element: exists on server → PATCH; local-only → created via /bulk
     * (atomic, server-side FK resolution handles cross-links in first pushes).
     * Elements that exist ONLY on the server are reported, never deleted —
     * the full-replace delete class is gone by design.
     */
    private async uploadViaV2(pin: number, worldFolder: string, worldData: Record<string, unknown>): Promise<void> {
        const resolved = await resolveWorldKey(this.app, worldFolder, this.plugin?.settings.apiKey);
        if (resolved.source === 'local-world') {
            new Notice(LOCAL_WORLD_SYNC_MESSAGE, 8000);
            return;
        }
        if (resolved.readOnly) {
            new Notice(READ_ONLY_WORLD_MESSAGE, 8000);
            return;
        }
        if (!resolved.apiKey) {
            new Notice('Upload failed: no API key found in World.md or settings.');
            return;
        }
        if (!resolved.ownWorld) {
            new Notice('Warning: using the plugin settings key (no key in this world\'s World.md). Verify it belongs to this world.', 10000);
        }
        const client = new V2Client(resolved.apiKey, String(pin));

        try {
            // Server element index — ids that exist right now (deletes drop out).
            const serverIds = new Set<string>();
            const walk = await client.changesWalk();
            const latestOp = new Map<string, string>();
            for (const change of walk.changes) latestOp.set(change.id, change.op);
            // What the feed last called each element (an upsert before its
            // delete), to name a deleted link target no note here holds.
            const feedName = new Map<string, string>();
            for (const change of walk.changes) {
                const name = (change as { element?: { name?: unknown } }).element?.name;
                if (typeof name === 'string' && name) feedName.set(change.id, `${change.type.charAt(0).toUpperCase()}${change.type.slice(1)} "${name}"`);
            }
            for (const [id, op] of latestOp) if (op === 'upsert') serverIds.add(id);

            // Hidden by the world's owner: a hidden row's id,
            // an id on a hidden list the walk does not show again, and every
            // stub. Never created, never updated, and links to them left out.
            const hiddenIds = new Set<string>(this.stubIds);
            for (const change of walk.changes) {
                if (change.op === 'delete' && change.reason === 'hidden') hiddenIds.add(change.id);
                else if (!this.stubIds.has(change.id)) hiddenIds.delete(change.id);
            }
            for (const list of Object.values(this.plugin?.settings.hiddenOnServer ?? {})) {
                for (const id of list) if (latestOp.get(id) !== 'upsert') hiddenIds.add(id);
            }
            let hiddenSkipped = this.stubIds.size;
            // Kept by a role (or no-reason) reset: keel answers the id 404, and
            // the note is never created again until the feed names it (Kael's
            // read, 2026-10-20).
            const leftViewIds = new Set<string>();
            for (const list of Object.values(this.plugin?.settings.leftView ?? {})) {
                for (const id of list) if (!latestOp.has(id) && !hiddenIds.has(id)) leftViewIds.add(id);
            }
            let leftViewSkipped = 0;
            let lastKnownSkipped = 0;

            // Partition local elements.
            const toCreate: { type: string; element: Record<string, unknown> }[] = [];
            const toUpdate: { type: string; id: string; payload: Record<string, unknown> }[] = [];
            for (const category in worldData) {
                if (category === 'World') continue;
                const elements = worldData[category];
                if (!Array.isArray(elements)) continue;
                const type = category.toLowerCase();
                for (const raw of elements) {
                    const element = toV2Payload(raw as Record<string, unknown>);
                    const id = element.id ? String(element.id) : null;
                    if (!id) continue; // no identity — validator should have caught it
                    if (hiddenIds.has(id)) {
                        hiddenSkipped++;
                        continue;
                    }
                    if (leftViewIds.has(id)) {
                        leftViewSkipped++;
                        continue;
                    }
                    // A whole note kept as last known over a stub keel now
                    // serves: never sent, counted with the known-of notes.
                    if (this.plugin && isLastKnownId(this.plugin.settings, id)) {
                        lastKnownSkipped++;
                        continue;
                    }
                    if (serverIds.has(id)) {
                        const { id: _id, ...patchFields } = element;
                        toUpdate.push({ type, id, payload: patchFields });
                    } else {
                        toCreate.push({ type, element });
                    }
                }
            }
            const localIds = new Set<string>();
            // The ids the deleted list keeps: each note's own, and every id
            // its fields hold (a raw-id link to an element with no note
            // here), so a save leaves such a link out (the fix round, item 8).
            const guarded = new Set<string>();
            for (const category in worldData) {
                if (category === 'World') continue;
                const elements = worldData[category];
                if (!Array.isArray(elements)) continue;
                for (const raw of elements) {
                    const id = (raw as Record<string, unknown>).id;
                    if (id) localIds.add(String(id));
                    for (const v of Object.values(raw as Record<string, unknown>).flat()) {
                        if (typeof v === 'string' && ELEMENT_ID.test(v)) guarded.add(v);
                    }
                }
            }
            for (const id of localIds) guarded.add(id);
            const serverOnly = [...serverIds].filter(id => !localIds.has(id) && !this.knownOfIds.has(id)).length;

            // Deleted on onlyworlds.com: the walk's own deletes, plus the list a
            // save or Download kept. Their kept notes are never recreated
            // without the user's word (Kael's second read, N4).
            const leftOut = await this.askAboutDeleted(client, latestOp, serverIds, toCreate, guarded, new Set([...hiddenIds, ...leftViewIds]));
            for (const id of leftOut.ids) {
                const at = toCreate.findIndex(i => String(i.element.id) === id);
                if (at >= 0) toCreate.splice(at, 1);
            }
            // And out of every note's links, new and existing alike: keel
            // refuses a payload linking an element it does not have, all its
            // other fields with it (Kael's third read, 1). That is every id
            // deleted on onlyworlds.com and not being created again, whether a
            // note here holds it or not (round C, 5). The notes keep them.
            let linksStripped = 0;
            const strippedTargets = new Set<string>();
            // A known-of note keel does not serve (out of view, or never on
            // this world's server): a link to it is refused, so it is left out.
            // One keel serves stays linked.
            const knownOfAbsent = [...this.knownOfIds].filter(id => !serverIds.has(id));
            const stripIds = [...[...leftOut.deleted].filter(id => !leftOut.recreate.has(id)), ...hiddenIds, ...leftViewIds, ...knownOfAbsent];
            if (stripIds.length > 0) {
                const strip = (type: string, fields: Record<string, unknown>) => {
                    const out = withoutLinks(type, fields, stripIds);
                    if (JSON.stringify(out) === JSON.stringify(fields)) return fields;
                    linksStripped++;
                    const kept = new Set(Object.values(out).flat());
                    for (const v of Object.values(fields).flat()) {
                        if (typeof v === 'string' && stripIds.includes(v) && !kept.has(v)) strippedTargets.add(v);
                    }
                    return out;
                };
                for (const item of toCreate) item.element = strip(item.type, item.element);
                for (const item of toUpdate) item.payload = strip(item.type, item.payload);
            }
            const strippedNames = [...strippedTargets].map(id => leftOut.nameOf.get(id) ?? this.stubNames.get(id) ?? this.knownOfNames.get(id) ?? feedName.get(id)
                ?? (hiddenIds.has(id) ? `an element hidden by the world's owner (${id})`
                    : leftViewIds.has(id) ? `an element no longer in your view (${id})` : `an element deleted there (${id})`));

            // Progress feedback — the sweep can run for a minute on a big world.
            new Notice(`Uploading ${toCreate.length + toUpdate.length} elements (${toCreate.length} new, ${toUpdate.length} existing)...`);

            // Creates first (/bulk — FK targets exist before updates run; links
            // among the batch's own items resolve server-side).
            //
            // ★ Count what keel ANSWERED, item by item. /bulk is HTTP 200 always,
            // non-atomic by default, with one result per item in request order:
            // { errors, items: [{ status: 201 created | 200 replaced | <error>,
            // id, error? }] } (keel core/bulk_api.py BulkResult). Counting
            // toCreate.length reported every refused item as created.
            // An item with no result is a failure, never a guess.
            let created = 0;
            let replaced = 0;
            const landed: string[] = [];
            const failures: string[] = [...this.refusedNotes];
            if (toCreate.length > 0) {
                const body = await client.bulkCreate(toCreate);
                const results = Array.isArray(body?.items) ? (body.items as unknown[]) : [];
                toCreate.forEach((item, i) => {
                    const r = (results[i] ?? null) as { status?: unknown; error?: { message?: unknown } } | null;
                    const status = typeof r?.status === 'number' ? r.status : null;
                    if (status === 201) {
                        created++;
                        landed.push(String(item.element.id));
                    } else if (status === 200) {
                        replaced++; // the id already existed: keel replaced it
                        landed.push(String(item.element.id));
                    } else {
                        const name = item.element.name ? String(item.element.name) : String(item.element.id);
                        const why = typeof r?.error?.message === 'string'
                            ? r.error.message
                            : status !== null ? `status ${status}` : 'no result from the server';
                        failures.push(`${item.type} "${name}": ${why}`);
                    }
                });
            }

            // Updates, per element; collect failures instead of aborting the sweep.
            // Each PATCH carries the change_seq its note was last pulled or
            // saved at as If-Match: an element another
            // writer changed since is refused (412), not reverted, and named.
            const knownSeqs = await readChangeSeqIndex(this.app, worldFolder);
            // /bulk answers no change_seq: a number kept for a created id is not its own.
            const seqs: Record<string, number | null> = {};
            for (const id of landed) seqs[id] = null;
            const stale: string[] = [];
            let updated = 0;
            const progressEvery = 50;
            for (const item of toUpdate) {
                const name = item.payload.name ? String(item.payload.name) : item.id;
                try {
                    const saved = await client.update(item.type, item.id, item.payload, { ifMatch: knownSeqs[item.id] ?? null });
                    seqs[item.id] = changeSeqOf(saved);
                    updated++;
                    if (updated % progressEvery === 0) {
                        new Notice(`Uploading... ${updated}/${toUpdate.length}`);
                    }
                } catch (e) {
                    if (isStaleWrite(e)) {
                        stale.push(`${item.type.charAt(0).toUpperCase()}${item.type.slice(1)} "${name}"`);
                        continue;
                    }
                    failures.push(`${item.type} "${name}": ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            await recordChangeSeqs(this.app, worldFolder, seqs);

            // The world's own units (standard 00.31.00): sent only when World.md
            // changed them. Never aborts the sweep: the elements already landed.
            let unitsNote = '';
            try {
                const sentUnits = await pushWorldUnits(client, this.localWorldUnits(worldData));
                if (Object.keys(sentUnits).length > 0) unitsNote = ' World units updated.';
            } catch (e) {
                const why = e instanceof V2ApiError && e.status === 403
                    ? 'only the world\'s owner can change them'
                    : (e instanceof Error ? e.message : String(e));
                console.error('Upload: world units not sent:', e);
                unitsNote = ` World units not sent: ${why}.`;
            }

            const failedNote = failures.length > 0 ? `, ${failures.length} failed` : '';
            let summary = `Upload complete: ${created} created, ${updated + replaced} updated${failedNote}.${unitsNote}`;
            if (serverOnly > 0) {
                summary += ` ${serverOnly} element${serverOnly === 1 ? '' : 's'} exist only on the server (not deleted).`;
            }
            if (linksStripped > 0) {
                summary += ` Links to ${strippedNames.join(', ')} left out of ${linksStripped} note${linksStripped === 1 ? '' : 's'}.`;
            }
            if (hiddenSkipped > 0) {
                summary += ` ${hiddenSkipped} note${hiddenSkipped === 1 ? '' : 's'} hidden by the world's owner ${hiddenSkipped === 1 ? 'was' : 'were'} not sent.`;
            }
            if (leftViewSkipped > 0) {
                summary += ` ${leftViewSkipped} note${leftViewSkipped === 1 ? '' : 's'} no longer in your view ${leftViewSkipped === 1 ? 'was' : 'were'} not sent.`;
            }
            const knownOfSkipped = this.knownOfIds.size + lastKnownSkipped;
            if (knownOfSkipped > 0) {
                summary += ` ${knownOfSkipped} known-of note${knownOfSkipped === 1 ? ' was' : 's were'} not sent.`;
            }
            if (this.dependsOnKept.length > 0) {
                const n = this.dependsOnKept.length;
                const shown = this.dependsOnKept.slice(0, 3).join(', ') + (n > 3 ? ` +${n - 3} more` : '');
                summary += ` Your lines under "Depends on" in ${shown} were kept in ${n === 1 ? 'the note' : 'those notes'}, not sent.`;
            }
            new Notice(summary, 8000);
            if (stale.length > 0) new Notice(staleUploadMessage(stale), 15000);
            if (leftOut.names.length > 0) {
                new Notice(`Left out, deleted on onlyworlds.com: ${leftOut.names.join(', ')}. Their notes are kept.`, 12000);
            }
            const recreated = landed.filter(id => leftOut.recreate.has(id));
            if (this.plugin && recreated.length > 0) await forgetDeleted(this.plugin, leftOut.worldId, recreated);
            if (this.skippedLinkFields > 0) {
                new Notice(`${this.skippedLinkFields} link field${this.skippedLinkFields === 1 ? '' : 's'} skipped (unresolvable links) — server values kept. See console for details.`, 10000);
            }
            if (this.ambiguousLinks.length > 0) {
                new Notice(ambiguousLinksMessage(this.ambiguousLinks), 15000);
            }
            if (failures.length > 0) {
                console.error('Upload failures:', failures);
                new Notice(`${failures.length} element${failures.length === 1 ? '' : 's'} failed — first: ${failures[0]}`, 15000);
            }
        } catch (error) {
            console.error('Upload error:', error);
            if (error instanceof V2ApiError) {
                if (error.status === 401 || error.status === 403) {
                    new Notice('Upload failed: Invalid PIN or API key, or the key lacks write access.');
                } else {
                    new Notice(`Upload failed: ${error.message}`, 15000);
                }
            } else {
                new Notice(`Error during upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        }
    }

    
    
    

    async collectWorldData(worldFolder: string) {
        this.skippedLinkFields = 0; // fresh count per sweep (incremented in parseTemplate)
        this.ambiguousLinks = [];
        this.refusedNotes = [];
        this.dependsOnKept = [];
        this.stubIds = new Set();
        this.stubNames = new Map();
        this.knownOfIds = new Set();
        this.knownOfNames = new Map();
        const fs = this.app.vault.adapter;
        let worldData: Record<string, unknown> = {};
    
        // Path to the 'World' file inside the selected world folder
        const worldFilePath = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/World.md`);
    
        // Read the 'World' file content and parse it
        try {
            const worldFileContent = await fs.read(worldFilePath); 
            const worldInfo = this.parseWorldFile(worldFileContent);
            // The unit lines are read by their own tolerant parser: a present
            // line is a value ("" = not set), an absent line stays absent.
            worldData['World'] = { ...worldInfo, ...parseWorldUnits(worldFileContent) }; // Directly assign the object, not in an array
        } catch (error) {
            console.error('Error reading World file:', error);
            const msg = error instanceof Error ? error.message : String(error);
            new Notice('Could not read the World file: ' + msg);
            return {}; // Stop further processing if the World file cannot be read
        }
    
        // Iterate over categories to collect their data
        for (const categoryKey in Category) {
            const category = Category[categoryKey];
            if (isNaN(Number(category))) {
                // The type's notes in either folder spelling (`Location`, an older `Location (2)`).
                const elementsPath = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements`);
                const files = this.app.vault.getFiles().filter(file => file.extension === 'md' && isInCategoryFolder(file.path, elementsPath, category));
     
                const categoryData = await Promise.all(files.map(async (file) => {
                    // Phase B: frontmatter notes read via the shared element reader
                    // (id + typed fields + extension namespaces preserved); legacy
                    // span notes still fall through to the span parser so a mixed,
                    // partly-migrated world uploads correctly either way.
                    const fileContent = await fs.read(file.path);
                    if (isKnownOfNote(fileContent) && !isStubNote(fileContent)) {
                        // Known of: a stub of the server's element, never sent
                        // (the folder spec §4.4 rule 3). Links to
                        // it are real and travel; it is counted in the summary.
                        const id = parseRawFrontmatterScalars(splitNote(fileContent).frontmatter, ['id']).id;
                        if (id) {
                            this.knownOfIds.add(id);
                            this.knownOfNames.set(id, `${category} "${file.basename}"`);
                        }
                        return {};
                    }
                    if (isStubNote(fileContent)) {
                        // Hidden by the world's owner: the stub holds no field
                        // of the element, and is never sent.
                        const id = parseRawFrontmatterScalars(splitNote(fileContent).frontmatter, ['id']).id;
                        if (id) {
                            this.stubIds.add(id);
                            this.stubNames.set(id, `${category} "${file.basename}"`);
                        }
                        return {};
                    }
                    if (!isSpanFormat(fileContent) && file instanceof TFile) {
                        const parsed = await readElement(this.app, file);
                        // id rides OUTSIDE parsed.fields — without it the upload
                        // sweep's `if (!id) continue` silently skips every
                        // frontmatter element (gate finding, 2026-07-16).
                        if (parsed?.unclosedFence) {
                            // Never sent cut short: named in the summary instead.
                            this.refusedNotes.push(unclosedFenceMessage(`${category} "${parsed.name}"`, parsed.unclosedFence));
                            return {};
                        }
                        if (parsed) {
                            this.ambiguousLinks.push(...parsed.ambiguousLinks);
                            if (parsed.dependsOnKept) this.dependsOnKept.push(file.basename);
                            return { id: parsed.id, ...parsed.fields };
                        }
                    }
                    return await this.parseTemplate(fileContent, worldFolder);
                }));
    
                // Filter out empty entries
                worldData[category] = categoryData.filter(item => Object.keys(item).length > 0);
            }
        }
    
        // Add debug logging at the end of the method, before returning the data
        try {
         //   console.log("WORLD DATA COLLECTION COMPLETE - Raw data structure:");
         //   console.log(JSON.stringify(worldData, null, 2));
            
            return worldData;
        } catch (error) {
            console.error("Error collecting world data:", error);
            new Notice("Error collecting world data: " + (error instanceof Error ? error.message : "Unknown error"));
            return null;
        }
    }
    
    /**
     * The new elements of this sweep that were deleted on onlyworlds.com: the
     * walk's own latest delete for an id, or an id in the deleted list a save or
     * Download kept (settings.deletedOnServer). The list is brought up to the
     * walk (a full walk from the epoch, so it is current) and kept. When any is
     * about to be created, one dialog asks "create them again?": Create again
     * keeps them in the batch (`recreate`), Leave out returns them (`ids`,
     * named in `names`). Kael's second read, N4.
     */
    private async askAboutDeleted(
        client: V2Client,
        latestOp: Map<string, string>,
        serverIds: Set<string>,
        toCreate: { type: string; element: Record<string, unknown> }[],
        guardedIds: Set<string>,
        hiddenIds: Set<string> = new Set()
    ): Promise<{ ids: string[]; names: string[]; recreate: Set<string>; worldId: string; deleted: Set<string>; nameOf: Map<string, string> }> {
        const none = { ids: [], names: [], recreate: new Set<string>(), worldId: '', deleted: new Set<string>(), nameOf: new Map<string, string>() };
        let worldId = '';
        try {
            worldId = String((await client.getWorld()).id ?? '');
        } catch {
            worldId = '';
        }
        const deleted = new Set<string>();
        for (const id of (worldId && this.plugin?.settings.deletedOnServer?.[worldId]) || []) {
            if (!serverIds.has(id)) deleted.add(id);
        }
        for (const [id, op] of latestOp) {
            if (op === 'delete') deleted.add(id);
            else deleted.delete(id);
        }
        // A hidden id is never offered back, nor kept on the deleted list.
        for (const id of hiddenIds) deleted.delete(id);
        if (worldId && this.plugin) {
            // Kept: only ids with a note in this vault or linked from one, the
            // ones the list guards (Kael's third read, 4; the fix round, item 8).
            this.plugin.settings.deletedOnServer = {
                ...(this.plugin.settings.deletedOnServer ?? {}),
                [worldId]: [...deleted].filter(id => guardedIds.has(id)),
            };
            try { await this.plugin.saveSettings(); } catch { /* the list is right for this sweep */ }
        }
        const again = toCreate.filter(i => deleted.has(String(i.element.id)));
        if (again.length === 0) return { ...none, worldId, deleted };
        const names = again.map(i => `${i.type.charAt(0).toUpperCase()}${i.type.slice(1)} "${String(i.element.name ?? i.element.id)}"`);
        const one = again.length === 1;
        const yes = await confirm(
            this.app,
            `${one ? '1 element was' : `${again.length} elements were`} deleted on onlyworlds.com: create ${one ? 'it' : 'them'} again?`,
            [...names, `Their notes are still in the vault. Creating ${one ? 'it' : 'them'} again brings ${one ? 'it' : 'them'} back for everyone in the world; Leave out uploads everything else.`],
            'Create again',
            'Leave out'
        );
        const ids = again.map(i => String(i.element.id));
        const nameOf = new Map(ids.map((id, n) => [id, names[n]]));
        return yes
            ? { ids: [], names: [], recreate: new Set(ids), worldId, deleted, nameOf }
            : { ids, names, recreate: new Set<string>(), worldId, deleted, nameOf };
    }

    /** The unit fields collectWorldData read from World.md (absent stays absent). */
    private localWorldUnits(worldData: Record<string, unknown>): WorldUnits {
        const world = worldData['World'];
        const units: WorldUnits = {};
        if (!world || typeof world !== 'object') return units;
        for (const field of WORLD_UNIT_FIELDS) {
            const v = (world as Record<string, unknown>)[field];
            if (typeof v === 'string') units[field] = v;
        }
        return units;
    }

    private parseWorldFile(content: string): Record<string, string | string[]> {
        let currentSection: string | null = null;
        const data: Record<string, string | string[]> = {};
    
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
                } else {
                    data[key] = value;
                }
            }
        });
    
        return data;
    }
    
    
    
    private async extractLinkedIds(linkedText: string, lineText: string, worldFolder: string): Promise<string[] | null> {
        const linkPattern = /\[\[(.*?)\]\]/g;
        const ids: string[] = [];
        let match;
    
        // Extract the element type from the surrounding line context
        const elementTypeMatch = /data-tooltip="(Single|Multi) ([^"]+)"/.exec(lineText);
        const elementType = elementTypeMatch ? elementTypeMatch[2] : null; 
    
        if (!elementType) {
            console.error("Element type not found in the linked text");
            return ids;
        }
    
        let unresolved = 0;
        while ((match = linkPattern.exec(linkedText)) !== null) {
            const linkedName = match[1];

            // A uuid-shaped link IS the id (download writes [[<id>]] when it
            // can't resolve a name) — pass it through, identity preserved.
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(linkedName)) {
                ids.push(linkedName);
                continue;
            }

            // Search for the element by name content instead of constructing file path
            const elementId = await this.findElementIdByName(linkedName, elementType, worldFolder);
            if (elementId) {
                ids.push(elementId);
            } else {
                unresolved++;
                console.error(`Linked file not found: ${linkedName}`);
            }
        }
        // Any unresolved link poisons the whole field: pushing a REDUCED list
        // would silently strip server-side links (the 2.3.0 smoke test class).
        // Returning null tells the caller to OMIT the field — server value wins.
        if (unresolved > 0) {
            console.warn(`Link field skipped (${unresolved} unresolved) — server value preserved.`);
            return null;
        }
        return ids;
    }
    
    private async findElementIdByName(elementName: string, elementType: string, worldFolder: string): Promise<string | null> {
        const elementsPath = normalizePath(`OnlyWorlds/Worlds/${worldFolder}/Elements`);
        const files = this.app.vault.getFiles().filter(file => file.extension === 'md' && isInCategoryFolder(file.path, elementsPath, elementType));
        
        for (const file of files) {
            try {
                const fileContent = await this.app.vault.read(file);
                const { name, id } = this.parseElement(fileContent);

                // Match by name content rather than filename. Compare sanitized
                // forms too: wikilinks carry the FILENAME form (illegal chars
                // replaced), while the note's Name field keeps the exact name.
                if (name === elementName ||
                    (name && sanitizeFileName(name) === sanitizeFileName(elementName))) {
                    return id;
                }
            } catch (error) {
                console.error(`Error reading file ${file.path}:`, error);
            }
        }

        return null;
    }
    
    async parseTemplate(content: string, worldFolder: string): Promise<Record<string, unknown>> {
        let currentSection: string | null = null;
        const data: Record<string, unknown> = {};

        const sectionPattern = /^##\s*(.+)$/; // Pattern to identify sections
        // Capture the tooltip so link/number fields are typed like SaveElementCommand.
        const keyValuePattern = /- <span class="[^"]+" data-tooltip="([^"]+)">(.+?)<\/span>:\s*(.*)/; // tooltip, key, value

        const lines = content.split('\n');
        for (const line of lines) {
            const sectionMatch = line.match(sectionPattern);
            if (sectionMatch) {
                currentSection = this.toSnakeCase(sectionMatch[1]);
                continue;
            }

            const match = line.match(keyValuePattern);
            if (match) {
                const tooltip = match[1].trim();
                const originalKey = match[2].replace(/\*\*/g, '');
                let key = this.toSnakeCase(originalKey);
                // Decode entities from pre-noEscape notes so names/text ship raw,
                // and [[wikilink]] display text matches the target note's name.
                const value = decodeHtmlEntities(match[3].trim());

                // Special handling for TTRPG stats - use uppercase keys
                const ttrpgStats = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
                if (ttrpgStats.includes(key.toLowerCase())) {
                    key = key.toUpperCase();
                }

                const lowerTooltip = tooltip.toLowerCase();
                // --- Links: ship as <field>_id / <field>_ids (UUIDs, never names) ---
                if (lowerTooltip.startsWith('single ') || lowerTooltip.startsWith('multi ')) {
                    const ids = value ? await this.extractLinkedIds(value, line, worldFolder) : [];
                    // A non-wikilink value in a link field can't be resolved to a UUID here
                    // (extractLinkedIds only matches [[Name]]). Never ship a raw name.
                    if (value && !value.includes('[[')) {
                        console.warn(`Link field "${key}" holds a non-wikilink value; nulling instead of shipping a name: "${value}"`);
                    }
                    if (ids === null) {
                        // Unresolved link(s) inside the field — OMIT it so the
                        // PATCH can't strip server-side links.
                        this.skippedLinkFields++;
                    } else if (lowerTooltip.startsWith('single ')) {
                        data[`${key}_id`] = ids.length > 0 ? ids[0] : null;
                    } else {
                        data[`${key}_ids`] = ids;
                    }
                }
                // --- Numbers ---
                else if (lowerTooltip === 'number' || ttrpgStats.includes(key.toLowerCase()) || key.match(/^[A-Z]{3}$/)) {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && /^\d+$/.test(value)) {
                        data[key] = num;
                    } else {
                        data[key] = value === '' ? null : value;
                    }
                }
                // --- Image fields ---
                else if (key === 'image' || key === 'image_url') {
                    if (value === 'None' || value === 'No image set') {
                        data[key] = '';
                    } else {
                        data[key] = value;
                    }
                }
                // --- Text (default) ---
                else {
                    // Empty fields ship as null, never "" — the API
                    // 422s "" on integer fields (height, weight, dates),
                    // while null reads as "no value" for every kind.
                    // SaveElementCommand's parser already does this.
                    data[key] = value === '' ? null : value;
                }
            }
        }

        return data;
    }
    
    
    
    private parseElement(content: string): { name: string, id: string } {
        // Adjust the regex to capture the full ID including dashes
        const idMatch = content.match(/<span class="text-field" data-tooltip="Text">Id<\/span>:\s*([^\r\n<]+)/);
        const nameMatch = content.match(/<span class="text-field" data-tooltip="Text">Name<\/span>:\s*([^\r\n<]+)/);
        
        const id = idMatch ? idMatch[1].trim() : "Unknown Id";
        // Decode so the name matches decoded [[wikilink]] text in findElementIdByName
        // even for target notes still escaped on disk.
        const name = nameMatch ? decodeHtmlEntities(nameMatch[1].trim()) : "Unnamed Element";

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
