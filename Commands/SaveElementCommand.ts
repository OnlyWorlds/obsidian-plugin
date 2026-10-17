import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type OnlyWorldsPlugin from '../main';
import { readElement } from '../vault/element-file';
import { LOCAL_WORLD_SYNC_MESSAGE, READ_ONLY_WORLD_MESSAGE, resolveWorldKey } from '../vault/world-key';
import { sanitizeFileName, WorldService } from '../Scripts/WorldService';
import { decodeHtmlEntities } from '../Scripts/htmlEntities';
import { toV2Payload, V2ApiError } from '../client-v2';
import { diffPayload, getCategorySchema } from '../vault/element-transform';
import { CreateFirstModal, leftOutLines, type CreateFirstItem } from '../Modals/CreateFirstModal';
import { forgetDeleted, readDeletedOnServer, type DeletedListClient, type DeletedView } from '../sync/deleted-on-server';
import { confirm } from '../Modals/ConfirmModal';

// Define the structure for element data (adapt as needed based on actual fields)
interface ElementData {
    id?: string; // ID is handled separately for the URL path
    name?: string;
    [key: string]: unknown; // Allow other fields
}

// Define the structure for world file data (adapt as needed)
interface WorldFileData {
    api_key?: string;
    [key: string]: unknown;
}

/**
 * What a save did. `ok` is true only when the server holds the note's state
 * afterwards (created, updated, or already equal); every early return and every
 * refused call is `ok: false` with the reason the user was shown. Auto-sync sets
 * its status from this — a failure must never end on "synced" (OW Infra #166
 * row 7).
 */
export type SaveResult =
    | { ok: true; outcome: 'created' | 'updated' | 'unchanged' }
    | { ok: false; reason: string };

/** The Notice for links left out because their name matches several types. */
export function ambiguousLinksMessage(links: string[]): string {
    const names = [...new Set(links)];
    const shown = names.slice(0, 3).join(', ');
    const more = names.length > 3 ? ` +${names.length - 3} more` : '';
    return `Not saved to those links: ${shown}${more}. ` +
        `${names.length === 1 ? 'That name matches' : 'Those names match'} notes of more than one type — ` +
        `rename one of the notes, then save again.`;
}

/**
 * What the create-first walk found: the targets to create, in order, and
 * those left out because the change feed reported them deleted.
 */
interface CreateFirstPlan {
    firsts: PendingCreate[];
    leftOut: CreateFirstItem[];
    /** More than MAX_CREATE_FIRST targets: none is created. */
    overflow?: boolean;
    /** This device cannot tell a never-uploaded note from a deleted one (no stored cursor). */
    cannotTell?: boolean;
}

const NO_PLAN: CreateFirstPlan = { firsts: [], leftOut: [] };

/** The most link targets one save creates first (Kael's read, should-fix 2). */
const MAX_CREATE_FIRST = 50;

/** Past the cap: nothing is created, Upload World sends the group. */
const OVERFLOW_MESSAGE =
    `More than ${MAX_CREATE_FIRST} linked notes are not on onlyworlds.com yet, so nothing was created or saved. ` +
    'Run Upload World to send them all, then save this note again.';

/** What a cancelled create-first dialog leaves the user with. */
const CANCELLED_MESSAGE = 'Save cancelled: nothing was created or saved.';

/** A local note created before the note that links to it (OW Infra #166 row 8). */
interface PendingCreate {
    type: string;
    id: string;
    name: string;
    payload: Record<string, unknown>;
}

/** "Created Location "Vallaki", Trait "Brave" first." — what a save created before the note itself. */
export function createdFirstMessage(firsts: { type: string; name: string }[]): string {
    const shown = firsts.slice(0, 3).map((f) => `${capitalize(f.type)} "${f.name}"`).join(', ');
    const more = firsts.length > 3 ? ` +${firsts.length - 3} more` : '';
    return `Created ${shown}${more} first.`;
}

/**
 * Auto-sync's addition to keel's refusal of a link to an element it does not
 * have (400 invalid_link, elements/resolve.py): the manual Save creates such
 * targets first, auto-sync never does (Kael's read, blocker).
 */
function missingLinkHint(error: unknown, manual: boolean): string {
    if (manual || !(error instanceof V2ApiError) || error.code !== 'invalid_link') return '';
    return ' A link names a note not on onlyworlds.com yet: Save Element creates them first.';
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The element ids a payload's link fields hold, by its type's schema; `keep` filters by field and id. */
function linkIdsOf(
    type: string,
    payload: Record<string, unknown>,
    keep?: (key: string, id: string) => boolean
): string[] {
    const schema = getCategorySchema(type);
    if (!schema) return [];
    const ids: string[] = [];
    for (const [key, value] of Object.entries(payload)) {
        const def = schema[key];
        if (!def || (def.type !== 'single_link' && def.type !== 'multi_link')) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
            if (typeof v === 'string' && v && (!keep || keep(key, v))) ids.push(v);
        }
    }
    return ids;
}

/** True when a server link value (an id, a list of ids, or stubs) already holds `id`. */
function linkHolds(value: unknown, id: string): boolean {
    const holds = (v: unknown) => v === id || (!!v && typeof v === 'object' && (v as { id?: unknown }).id === id);
    return Array.isArray(value) ? value.some(holds) : holds(value);
}

export class SaveElementCommand {
    app: App;
    plugin: OnlyWorldsPlugin;

    constructor(app: App, plugin: OnlyWorldsPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    // Helper method to convert strings to snake_case
    toSnakeCase(input: string): string {
        // Handle known specific cases first
        if (input === "API Key") return "api_key";
        if (input === "Id") return "id"; // Although ID is removed from payload later

        // General conversion: Add space before uppercase, lowercase, replace space with underscore
        return input
            // Add a space before uppercase letters (but not if it's the start of the string)
            .replace(/([A-Z])/g, ' $1')
            .trim() // Remove potential leading/trailing spaces
            .toLowerCase() // Convert to lowercase
            .replace(/[\s\-]+/g, '_') // Replace spaces and hyphens with underscores
            .replace(/_+/g, '_'); // Collapse multiple underscores (e.g., from acronyms)
    }

    /**
     * Save ONE note to the server. The caller names the note: the Save command
     * passes the active file, auto-sync passes the file whose timer fired.
     *
     * ⚑ Never read `workspace.getActiveFile()` in here. Auto-sync used to swap
     * the active note and let this method read it back; timers for several
     * notes edited in the same second then all saved whichever note was active
     * (one id hit ten times, seven never — OW Infra #166 row 4).
     */
    async execute(activeFile: TFile | null, opts: { manual?: boolean } = {}): Promise<SaveResult> {
        // The Save Element command passes manual; auto-sync never does. Only a
        // manual save creates link targets first (row 8; Kael's read, blocker).
        const manual = opts.manual === true;
        if (!activeFile || !(activeFile instanceof TFile)) {
            return this.fail("No active file selected or it's not a valid file.");
        }

        // 1. Validate Path and Extract Info
        const pathInfo = this.extractPathInfo(activeFile.path);
        if (!pathInfo) {
            return this.fail("The current file is not a valid OnlyWorlds element note.");
        }
        const { worldName, category } = pathInfo;

        // 2. Try v2 (frontmatter) first; fall back to v1 (span-tag) if no frontmatter id.
        let elementData: ElementData | null = null;
        const v2 = await readElement(this.app, activeFile);
        if (v2 && v2.id) {
            elementData = { id: v2.id, ...v2.fields };
            // A [[Name]] pointing at an element that exists only in the vault
            // resolves to nothing, so its whole field is omitted to avoid
            // stripping the server's copy. That is the right call — but saying
            // nothing means the user sees "saved" while the link they just made
            // did not travel. Name the elements and the fix.
            if (v2.unresolvedLinks.length > 0) {
                const names = [...new Set(v2.unresolvedLinks)];
                const shown = names.slice(0, 3).join(', ');
                const more = names.length > 3 ? ` +${names.length - 3} more` : '';
                new Notice(
                    `Not saved to those links: ${shown}${more}. ` +
                    `${names.length === 1 ? 'That element is' : 'Those elements are'} not on the server yet — ` +
                    `run "Export World" first, then save this note again.`,
                    12000
                );
            }
            // A generic link field (a Pin's element) whose name matches notes of
            // more than one type is never guessed: left out, and named here
            // (OW Infra #166 row 2).
            if (v2.ambiguousLinks.length > 0) {
                new Notice(ambiguousLinksMessage(v2.ambiguousLinks), 12000);
            }
        } else {
            const fileContent = await this.app.vault.read(activeFile);
            elementData = await this.parseElementContent(fileContent, activeFile.path);
        }

        if (!elementData) {
             console.error("Parsing error in:", activeFile.path);
             return this.fail("Could not parse element data from the note.");
        }

        const elementUuid = elementData.id;
        if (!elementUuid) {
            console.error("Missing ID in parsed data:", elementData);
            return this.fail("Could not find element ID in the note after parsing.");
        }

        // Remove ID from payload as it's in the URL path
        delete elementData.id;

        // 3. Resolve API Key. THIS world's World.md wins — in a multi-world vault
        // the settings key may belong to a different world, and the API routes a
        // write to whatever world the key names (a save under world B's folder
        // with world A's settings key lands the element in world A — the
        // wrong-world class, hit live 2026-07-12). Settings key is fallback ONLY
        // when the world carries no key of its own; the fallback warns.
        const resolved = await resolveWorldKey(this.app, worldName, this.plugin.settings.apiKey);
        if (resolved.source === 'local-world') {
            // Explicit local-only world: the note is already saved in the vault;
            // never fall through to the settings key (wrong-world class).
            return this.fail(LOCAL_WORLD_SYNC_MESSAGE, 8000);
        }
        if (resolved.readOnly) {
            // A read key can never write: refuse before any PIN (Kael's review 3.1).
            return this.fail(READ_ONLY_WORLD_MESSAGE, 8000);
        }
        const apiKey = resolved.apiKey ?? undefined;
        if (!apiKey) {
            return this.fail("Error getting API key: no API key in this world's World.md or in plugin settings.");
        }
        if (!resolved.ownWorld) {
            new Notice(`This world has no API key of its own; using your default key. Add its key to World.md to be sure edits land in the right world.`, 8000);
        }

        // 4. Build v2 client (pulls cached PIN, or prompts once per session)
        const client = await this.plugin.buildV2Client(apiKey);
        if (!client) {
            return this.fail("Save cancelled: PIN not provided.");
        }

        // 5. v2 wire payload: bare link names (suffixes stripped), world stripped.
        const type = category.toLowerCase();
        const payload = toV2Payload(elementData as Record<string, unknown>);
        const label = elementData.name || elementUuid;

        // 6. Read-before-PATCH (R7): fetch current server state, send only the
        // fields that actually changed. This leaves server-only fields (incl.
        // extension namespaces the note may not carry) untouched, instead of a
        // wholesale overwrite from the local parse. A GET 404 means the element
        // was never pushed — create it (the server preserves client-supplied ids).
        let current: Record<string, unknown> | null = null;
        try {
            current = await client.get(type, elementUuid);
        } catch (error) {
            if (this.isNotFound(error)) {
                try {
                    // A 404 is "never uploaded" or "deleted on the server". The
                    // deleted list (the feed read once from the stored cursor)
                    // tells them apart: a deleted element is never recreated by
                    // auto-sync, and only on the user's word by Save Element
                    // (Kael's second read, N1).
                    const view = await readDeletedOnServer(this.plugin, client);
                    let recreated = false;
                    if (view.ids.has(elementUuid)) {
                        if (!manual) {
                            return this.fail(`${label} was deleted on onlyworlds.com; Save Element can create it again.`, 10000);
                        }
                        const again = await confirm(
                            this.app,
                            `${capitalize(type)} "${label}" was deleted on onlyworlds.com: create it again?`,
                            ['Creating it again brings it back for everyone in the world.'],
                            'Create again'
                        );
                        if (!again) return this.fail(CANCELLED_MESSAGE);
                        recreated = true;
                    }
                    // Link targets that are notes in this vault but not on the
                    // server go first, or keel refuses the note (row 8).
                    // Only the manual Save walks (Kael's read, blocker): auto-sync
                    // leaves keel's refusal and says how to get past it.
                    const plan = manual
                        ? await this.unsyncedTargets(client, worldName, elementUuid, type, payload, undefined, view)
                        : NO_PLAN;
                    if (!(await this.approveCreateFirst(String(label), plan))) {
                        return this.fail(plan.overflow ? OVERFLOW_MESSAGE : CANCELLED_MESSAGE, plan.overflow ? 12000 : undefined);
                    }
                    const firsts = plan.firsts;
                    new Notice(`Creating ${category} "${label}"...`);
                    if (firsts.length > 0) {
                        const refused = await this.createTogether(client, [
                            ...firsts,
                            { type, id: elementUuid, name: String(label), payload },
                        ]);
                        if (refused) return this.fail(`Failed to create ${category}: ${refused}`, 12000);
                        if (recreated) await forgetDeleted(this.plugin, view.worldId, [elementUuid]);
                        new Notice(`${createdFirstMessage(firsts)} ${category} created.`, 8000);
                        return { ok: true, outcome: 'created' };
                    }
                    await client.create(type, { id: elementUuid, ...payload });
                    if (recreated) await forgetDeleted(this.plugin, view.worldId, [elementUuid]);
                    new Notice(`${category} created.`);
                    return { ok: true, outcome: 'created' };
                } catch (createError) {
                    console.error('Error during v2 create fallback:', createError);
                    const msg = createError instanceof Error ? createError.message : 'Unknown error';
                    return this.fail(`Failed to create ${category}: ${msg}${missingLinkHint(createError, manual)}`, 10000);
                }
            }
            console.error('Error during v2 GET (read-before-PATCH):', error);
            const msg = error instanceof Error ? error.message : 'Unknown error';
            return this.fail(`Failed to save ${category}: ${msg}`, 10000);
        }

        const changed = diffPayload(payload, current ?? {});
        if (Object.keys(changed).length === 0) {
            new Notice(`${category} "${label}" already up to date.`);
            return { ok: true, outcome: 'unchanged' };
        }

        try {
            new Notice(`Saving ${category} "${label}"...`);
            // A link this save adds may name a note not on the server yet:
            // create those first (row 8). Only ids the server's copy lacks are
            // looked up, so an unchanged link costs nothing.
            const plan = manual
                ? await this.unsyncedTargets(
                    client, worldName, elementUuid, type, changed, (key, id) => !linkHolds(current?.[key], id)
                )
                : NO_PLAN;
            let firstNote = '';
            if (!(await this.approveCreateFirst(String(label), plan))) {
                return this.fail(plan.overflow ? OVERFLOW_MESSAGE : CANCELLED_MESSAGE, plan.overflow ? 12000 : undefined);
            }
            const firsts = plan.firsts;
            if (firsts.length > 0) {
                const refused = await this.createTogether(client, firsts);
                if (refused) return this.fail(`${category} "${label}" not saved: ${refused}`, 12000);
                firstNote = `${createdFirstMessage(firsts)} `;
            }
            await client.update(type, elementUuid, changed);
            // Only the manual Save renames: auto-sync fires at every pause while
            // a name is typed, and each rename can rewrite every linking note
            // (Kael's read, 7).
            const renamed = manual && typeof changed.name === 'string'
                ? await this.renameToName(activeFile, changed.name, elementUuid)
                : null;
            const renameNote = renamed ? ` Note renamed to "${renamed}".` : '';
            new Notice(`${firstNote}${category} saved.${renameNote}`, firstNote || renamed ? 8000 : undefined);
            return { ok: true, outcome: 'updated' };
        } catch (error) {
            console.error('Error during v2 update call:', error);
            const msg = error instanceof Error ? error.message : 'Unknown error';
            return this.fail(`Failed to save ${category}: ${msg}${missingLinkHint(error, manual)}`, 10000);
        }
    }

    /**
     * The link targets of `payload` that are notes in this world without an
     * element on the server, each after its own such targets (depth-first,
     * one visited set, so a cycle ends). The note being saved is visited
     * first and never returned. A target that is no note here, or that the
     * server already has (or answers with anything but 404), is left alone.
     * `keep` narrows the payload's own links (the update path: only the ids
     * the server's copy lacks). OW Infra #166 row 8.
     */
    private async unsyncedTargets(
        client: { get(type: string, id: string): Promise<Record<string, unknown>> } & DeletedListClient,
        worldName: string,
        rootId: string,
        rootType: string,
        rootPayload: Record<string, unknown>,
        keep?: (key: string, id: string) => boolean,
        known?: DeletedView
    ): Promise<CreateFirstPlan> {
        const out: PendingCreate[] = [];
        const leftOut: CreateFirstItem[] = [];
        const visited = new Set<string>([rootId]);
        let index: Map<string, TFile> | null = null;
        let view: DeletedView | null = known ?? null;
        let overflow = false;
        let found = 0;
        const visit = async (type: string, payload: Record<string, unknown>, filter?: typeof keep): Promise<void> => {
            for (const id of linkIdsOf(type, payload, filter)) {
                if (overflow) return;
                if (visited.has(id)) continue;
                visited.add(id);
                index = index ?? this.worldNoteIndex(worldName);
                const file = index.get(id);
                if (!file) continue;
                const parsed = await readElement(this.app, file);
                if (!parsed || parsed.id !== id) continue;
                try {
                    await client.get(parsed.category, id);
                    continue; // already on the server
                } catch (error) {
                    if (!this.isNotFound(error)) continue;
                }
                // A 404 is "never pushed" or "deleted": an id the change feed
                // reported deleted is never recreated (Kael's read, blocker 1c).
                // The first 404 reads the feed once from the stored cursor, so a
                // delete no Download has seen yet counts too (second read, N3).
                view = view ?? (await readDeletedOnServer(this.plugin, client));
                if (view.ids.has(id)) {
                    leftOut.push({ type: parsed.category, name: parsed.name });
                    continue;
                }
                // A cap, not a sweep: past it the whole group is Upload World's
                // (Kael's read, should-fix 2; keel's /bulk takes at most 1000).
                // Counted when found, before walking into it: a target joins
                // `out` only on the way back out, so counting `out` let a chain
                // run past the cap (Kael's second read, N2).
                if (++found > MAX_CREATE_FIRST) {
                    overflow = true;
                    return;
                }
                const targetPayload = toV2Payload(parsed.fields);
                await visit(parsed.category, targetPayload);
                if (overflow) return;
                out.push({ type: parsed.category, id, name: parsed.name, payload: targetPayload });
            }
        };
        await visit(rootType, rootPayload, keep);
        return { firsts: out, leftOut, overflow, cannotTell: view ? !view.known : false };
    }

    /**
     * Before the creates: ask when there is something to create (the dialog
     * also lists what is left out), else name what is left out in a notice.
     * True means go on with the save.
     */
    private async approveCreateFirst(label: string, plan: CreateFirstPlan): Promise<boolean> {
        if (plan.overflow) return false;
        if (plan.firsts.length > 0) return this.confirmCreateFirst(label, plan);
        if (plan.leftOut.length > 0) new Notice(leftOutLines(plan.leftOut).join(' '), 12000);
        return true;
    }

    /**
     * After a save that changed the element's name, give its note that name
     * (Seethe's finding 4, h37 #6503: the server took the new name, the file
     * kept the old one). Through fileManager.renameFile, so the user's own
     * "update internal links" setting applies. A name another note holds gets
     * the twin suffix Download uses (`Name (1)`, WorldService
     * .generateUniqueFileName). Nothing happens when the setting is off, or
     * when the file already carries the name, a twin's `Name (N)` included.
     * Returns the new basename, or null. A failed rename is logged, never
     * failing a save that landed.
     */
    private async renameToName(file: TFile, name: string, id: string): Promise<string | null> {
        if (this.plugin.settings.renameNoteOnNameChange === false) return null;
        const base = sanitizeFileName(name);
        const current = file.basename;
        if (current === base || (current.startsWith(`${base} (`) && /\(\d+\)$/.test(current))) return null;
        const folder = file.parent?.path ?? file.path.slice(0, file.path.lastIndexOf('/'));
        // A change of case only is the same file on Windows and macOS: rename straight to it.
        const leaf = current.toLowerCase() === base.toLowerCase()
            ? `${base}.md`
            : await new WorldService(this.app).generateUniqueFileName(folder, name, id);
        const target = normalizePath(`${folder}/${leaf}`);
        try {
            await this.app.fileManager.renameFile(file, target);
            return leaf.replace(/\.md$/i, '');
        } catch (error) {
            console.error('[OnlyWorlds] Saved, but the note could not be renamed:', error);
            return null;
        }
    }

    /**
     * Ask before a manual Save creates link targets on onlyworlds.com: the
     * dialog lists each by type and name, Create or Cancel (Kael's read,
     * blocker 1b). Resolves true only on Create.
     */
    private confirmCreateFirst(label: string, plan: CreateFirstPlan): Promise<boolean> {
        return new Promise((resolve) => {
            new CreateFirstModal(
                this.app,
                label,
                plan.firsts.map((f) => ({ type: f.type, name: f.name })),
                plan.leftOut,
                resolve,
                plan.cannotTell === true
            ).open();
        });
    }

    /** This world's element notes by their frontmatter id. */
    private worldNoteIndex(worldName: string): Map<string, TFile> {
        const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
        const index = new Map<string, TFile>();
        for (const f of this.app.vault.getMarkdownFiles()) {
            if (!f.path.startsWith(prefix)) continue;
            const id = this.app.metadataCache.getFileCache(f)?.frontmatter?.id;
            if (typeof id === 'string' && !index.has(id)) index.set(id, f);
        }
        return index;
    }

    /**
     * Create these elements in ONE POST /bulk. keel validates every item's
     * links against the batch and the world, to a fixpoint, and applies the
     * survivors in one transaction (elements/bulk.py), so items may link to
     * each other, in a cycle too: no item is created bare and patched after.
     * Returns null when every item landed (201, or 200 if the id appeared
     * meanwhile), else the refused items with keel's reasons.
     */
    private async createTogether(
        client: { bulkCreate(items: { type: string; element: Record<string, unknown> }[]): Promise<Record<string, unknown>> },
        items: PendingCreate[]
    ): Promise<string | null> {
        const body = await client.bulkCreate(items.map((i) => ({ type: i.type, element: { id: i.id, ...i.payload } })));
        const results = Array.isArray(body?.items) ? (body.items as unknown[]) : [];
        const refused: string[] = [];
        items.forEach((item, i) => {
            const r = (results[i] ?? null) as { status?: unknown; error?: { message?: unknown } } | null;
            const status = typeof r?.status === 'number' ? r.status : null;
            if (status === 201 || status === 200) return;
            const why = typeof r?.error?.message === 'string'
                ? r.error.message
                : status !== null ? `status ${status}` : 'no result from the server';
            refused.push(`${capitalize(item.type)} "${item.name}": ${why}`);
        });
        return refused.length > 0 ? refused.join('; ') : null;
    }

    /** Show the reason (the Notice the user always got) and report the failure. */
    private fail(reason: string, timeout?: number): SaveResult {
        new Notice(reason, timeout);
        return { ok: false, reason };
    }

    // Match a genuine 404 so we don't fall back to create() on other failures.
    // V2ApiError carries the real status; the legacy message check stays as a
    // safety net for any non-V2ApiError wrapping.
    private isNotFound(error: unknown): boolean {
        if (error instanceof V2ApiError) {
            return error.status === 404;
        }
        return error instanceof Error && /^API Error 404\b/.test(error.message);
    }

    // Helper to extract World Name and Category from path
    extractPathInfo(filePath: string): { worldName: string; category: string } | null {
        // Example path: OnlyWorlds/Worlds/MyWorld/Elements/Character (3)/Hero.md
        const pattern = /^OnlyWorlds\/Worlds\/([^\/]+)\/Elements\/([^\/]+)\/.+\.md$/i;
        const match = filePath.match(pattern);
        if (match && match[1] && match[2]) {
            // Strip count suffix from category name (e.g., "Character (3)" -> "Character")
            const rawCategory = match[2];
            const baseCategoryName = rawCategory.replace(/\s*\(\d+\)$/, '');
         //   console.log(`[SaveElementCommand] Extracted category: "${rawCategory}" -> base: "${baseCategoryName}"`);
            return { worldName: match[1], category: baseCategoryName };
        }
        return null;
    }

    // Refined parser based on ExportWorldCommand's logic
    async parseElementContent(content: string, currentFilePath: string): Promise<ElementData | null> {
     //   console.log("Starting element parsing (v2)...");
        const data: ElementData = {};
        const lines = content.split('\n');

        // Regex to capture key, value, and tooltip:
        const linePattern = /- <span class="[^"]+" data-tooltip="([^"]+)">([^<]+)<\/span>:\s*(.*)/;
        const idPatternSimple = /Id<\/span>:\s*([a-f0-9\-]{36})/; // Separate pattern just for ID

        let foundId: string | null = null; // Track ID separately

        for (const line of lines) {
            // First, specifically check for the ID line
            const idMatchSimple = line.match(idPatternSimple);
            if (idMatchSimple && idMatchSimple[1]) {
                foundId = idMatchSimple[1].trim();
             //   console.log(`  -> Found ID via simple pattern: ${foundId}`);
                continue; // Don't process the ID line with the general pattern
            }

            // Process general key-value lines
            const match = line.match(linePattern);
            if (match) {
                const tooltip = match[1].trim();
                const key = match[2].trim();
                // Decode entities from notes written before noEscape: a name/link
                // stored as "The Kid&#x27;s Family" must become raw text so the
                // wikilink file lookup matches and the API stores the real name.
                const rawValue = decodeHtmlEntities(match[3].trim());
                let snakeKey = this.toSnakeCase(key);

                // Skip empty values, API expects null.
                // TTRPG stats need uppercase keys even when null.
                if (!rawValue || rawValue.toLowerCase() === 'none') {
                    const rawKeyLetters = key.replace(/[^a-zA-Z]/g, '').toUpperCase();
                    const ttrpgStats = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
                    const finalKey = ttrpgStats.includes(rawKeyLetters) ? rawKeyLetters : snakeKey;
                    data[finalKey] = null;
                    continue;
                }

              //  console.log(`  -> Field [${key}] (Tooltip: ${tooltip}): Raw value = "${rawValue}"`);

                // --- Handle Links based on Tooltip ---
                if (tooltip.toLowerCase().startsWith('single ') || tooltip.toLowerCase().startsWith('multi ')) {
                    // Get the IDs first
                    const ids = await this.extractLinkedIds(rawValue, tooltip, currentFilePath);
                    
                    // Determine the final key and assign value based on single/multi
                    if (tooltip.toLowerCase().startsWith('single ')) {
                        const finalKey = `${snakeKey}_id`; // Append _id for single links
                        data[finalKey] = ids.length > 0 ? ids[0] : null;
                     //   console.log(`     Recognized as Single Link field. Key: ${finalKey}, Assigned ID = ${data[finalKey]}`);
                    } else { // Must be multi
                        const finalKey = `${snakeKey}_ids`; // Append _ids for multi links
                        data[finalKey] = ids; // Assign array
                   //     console.log(`     Recognized as Multi Link field. Key: ${finalKey}, Assigned IDs = [${ids.join(', ')}]`);
                    }
                }
                // --- Handle Numbers ---
                else if (tooltip.toLowerCase() === 'number') {
                    const num = parseInt(rawValue, 10);
                    // TTRPG stats — API expects uppercase STR/DEX/CON/INT/WIS/CHA.
                    // The raw field name in the span could be "Str", "STR", "str", or "s_t_r"
                    // (the last from snake_casing all-caps input). Normalize from the raw key.
                    const rawKeyLetters = key.replace(/[^a-zA-Z]/g, '').toUpperCase();
                    const ttrpgStats = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];
                    const isTtrpgStat = ttrpgStats.includes(rawKeyLetters);
                    const finalKey = isTtrpgStat ? rawKeyLetters : snakeKey;
                    if (!isNaN(num) && /^\d+$/.test(rawValue)) {
                        data[finalKey] = num;
                    } else {
                        console.warn(`     Could not parse number for key "${key}": ${rawValue}. Assigning null.`);
                        data[finalKey] = null;
                    }
                }
                // --- Handle Text (Default) ---
                else {
                    data[snakeKey] = rawValue;
                 //   console.log(`     Recognized as Text: Assigned value = "${rawValue}"`);
                }
            }
        }

        // Add the separately found ID to the data object
        if (foundId) {
            data.id = foundId;
        } else {
             // Fallback: Try to find ID again if not found via simple pattern (less likely now)
             const idFallbackMatch = content.match(/Id<\/span>:\s*([a-f0-9\-]{36})/);
             if (idFallbackMatch && idFallbackMatch[1]) {
                 data.id = idFallbackMatch[1].trim();
              //   console.log(`  -> Found ID via fallback pattern: ${data.id}`);
             }
        }

        // Ensure name is present (simple extraction)
        if (!data.name) {
            const nameMatch = content.match(/Name<\/span>:\s*(.+)/);
            if (nameMatch && nameMatch[1]) {
                data.name = decodeHtmlEntities(nameMatch[1].trim().split('<')[0].trim());
            //    console.log(`  -> Found Name: ${data.name}`);
            }
        }

       // console.log("Finished element parsing (v2).");
        if (!data.id) {
            console.error("  -> CRITICAL: Element ID could not be found after parsing.");
        }
        return data.id ? data : null; // Return only if ID was found
    }

    // Refined ID extraction based on ExportWorldCommand logic
    async extractLinkedIds(linkedText: string, tooltip: string, currentFilePath: string): Promise<string[]> {
  //      console.log(`    Extracting IDs (v2) for Links: "${linkedText}"`);
        const ids: string[] = [];
        const linkPattern = /\[\[(.*?)\]\]/g; // Find [[Note Name]]
        let match;

        const pathInfo = this.extractPathInfo(currentFilePath);
        if (!pathInfo) {
            console.error("      Cannot extract IDs: World context not found.");
            return ids;
        }
        const { worldName } = pathInfo;

        // Determine the linked category from the tooltip (e.g., "Multi Link Traits" -> "Traits")
        const tooltipParts = tooltip.split(' ');
        const linkedCategory = tooltipParts.length > 1 ? tooltipParts[tooltipParts.length - 1] : null;

        if (!linkedCategory) {
            console.warn(`      Cannot extract IDs: Linked category not determined from tooltip: "${tooltip}"`);
            return ids;
        }
       // console.log(`      Determined linked category: ${linkedCategory}`);

        while ((match = linkPattern.exec(linkedText)) !== null) {
            const noteName = match[1];

            // A uuid-shaped link IS the id (download writes [[<id>]] when it
            // can't resolve a name) — pass through, identity preserved.
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noteName)) {
                ids.push(noteName);
                continue;
            }

            // Find the actual category folder (which might have count suffix)
            const actualCategoryFolder = await this.findCategoryFolderByBaseName(worldName, linkedCategory);
            if (!actualCategoryFolder) {
                console.warn(`      Cannot find category folder for: ${linkedCategory}`);
                continue;
            }
            
            // Wikilink text is the filename form; sanitize for the path lookup.
            const linkedFilePath = normalizePath(`${actualCategoryFolder}/${sanitizeFileName(noteName)}.md`);
        //    console.log(`      Looking for linked file at: ${linkedFilePath}`);

            try {
                const linkedFile = this.app.vault.getAbstractFileByPath(linkedFilePath);
                if (linkedFile instanceof TFile) {
              //      console.log(`        Found linked file.`);
                    const fileContent = await this.app.vault.read(linkedFile);
                    // Use the simpler ID extraction function (like ExportWorldCommand's parseElement)
                    const linkedElementData = this.parseElementIdAndName(fileContent); // NEW helper call
                    if (linkedElementData && linkedElementData.id !== "Unknown Id") {
                        ids.push(linkedElementData.id);
                  //      console.log(`        Successfully extracted ID: ${linkedElementData.id}`);
                    } else {
                        console.warn(`        Could not extract valid ID from linked file: ${linkedFilePath}`);
                    }
                } else {
                    console.warn(`        Linked file not found or is not a file: ${linkedFilePath}`);
                }
            } catch (error) {
                console.error(`        Error reading or parsing linked file ${linkedFilePath}:`, error);
            }
        }
   //     console.log(`    Finished extracting IDs (v2). Found: [${ids.join(', ')}]`);
        return ids;
    }

    // Helper to parse just ID and Name from content (like ExportWorldCommand)
    private parseElementIdAndName(content: string): { id: string, name: string } {
     //   console.log("        Parsing linked element ID/Name...");
        // Match ID: Use the regex from ExportWorldCommand
         const idMatch = content.match(/<span class="text-field" data-tooltip="Text">Id<\/span>:\s*([^\r\n<]+)/); 
         // Match Name: Use the regex from ExportWorldCommand
         const nameMatch = content.match(/<span class="text-field" data-tooltip="Text">Name<\/span>:\s*([^\r\n<]+)/);

         const id = idMatch && idMatch[1] ? idMatch[1].trim() : "Unknown Id";
         const name = nameMatch && nameMatch[1] ? nameMatch[1].trim() : "Unnamed Element"; 
    //     console.log(`        Found ID: ${id}, Name: ${name}`);
         return { id, name };
    }

    // Parser for World.md
    parseWorldFile(content: string): WorldFileData | null {
        const data: WorldFileData = {};
        const apiKeyRegex = /- \*\*API Key:\*\* (\S+)/; // Match "- **API Key:** <key>" (ow_ or classic)
        const match = content.match(apiKeyRegex);
        if (match && match[1]) {
            data.api_key = match[1].trim();
        }
        return Object.keys(data).length > 0 ? data : null; // Return null if no key found
    }

    // Helper method to find category folder by base name (handles count suffixes)
    async findCategoryFolderByBaseName(worldName: string, baseCategoryName: string): Promise<string | null> {
        const elementsPath = normalizePath(`OnlyWorlds/Worlds/${worldName}/Elements`);
        const elementsFolder = this.app.vault.getAbstractFileByPath(elementsPath);
        
        if (!(elementsFolder instanceof TFolder)) {
            console.warn(`Elements folder not found or not a folder: ${elementsPath}`);
            return null;
        }
        
        for (const child of elementsFolder.children) {
            if (child instanceof TFolder) {
                // Check if folder name starts with the base category name
                if (child.name === baseCategoryName || child.name.startsWith(`${baseCategoryName} (`)) {
                //    console.log(`[SaveElementCommand] Found category folder: ${child.path}`);
                    return child.path;
                }
            }
        }
        
        console.warn(`[SaveElementCommand] Category folder not found for: ${baseCategoryName}`);
        return null;
    }

}
