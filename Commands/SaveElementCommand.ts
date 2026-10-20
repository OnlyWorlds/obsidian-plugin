import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type OnlyWorldsPlugin from '../main';
import { likelyMisnamedMessage, readElement, unclosedFenceMessage } from '../vault/element-file';
import { LOCAL_WORLD_SYNC_MESSAGE, READ_ONLY_WORLD_MESSAGE, resolveWorldKey } from '../vault/world-key';
import { sanitizeFileName, WorldService } from '../Scripts/WorldService';
import { decodeHtmlEntities } from '../Scripts/htmlEntities';
import { toV2Payload, V2ApiError } from '../client-v2';
import { diffPayload, getCategorySchema, keepServerEscapes } from '../vault/element-transform';
import { CreateFirstModal, cannotTellLine, type CannotTellReason, type CreateFirstItem } from '../Modals/CreateFirstModal';
import { forgetDeleted, readDeletedOnServer, storedDeleted, type DeletedListClient, type DeletedView } from '../sync/deleted-on-server';
import { HIDDEN_NOT_SAVED, LEFT_VIEW_NOT_SAVED, isHiddenId, isLeftViewId, isStubNote } from '../sync/hidden-on-server';
import { KNOWN_OF_NOT_SAVED, LAST_KNOWN_NOT_SAVED, isLastKnownId } from '../sync/known-of';
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
    /** `local`: nothing is wrong, the note is never sent (a known-of note, OW Infra #454): auto-sync stays idle. */
    | { ok: false; reason: string; local?: true };

/**
 * The Notice for [[links]] a save left out because no element id answers
 * them: a name no note of this world carries, or a note this field cannot
 * link (no id yet, or another type than the field takes). `noteNames` holds
 * the world's note file names in lower case. Round C, 10: it named "Export
 * World", which resolves links the same way and so never helps.
 */
export function unresolvedLinksMessage(links: string[], noteNames: Set<string>): string {
    const leaf = (l: string) => l.slice(l.lastIndexOf('/') + 1).replace(/\.md$/i, '').toLowerCase();
    const list = (xs: string[]) => xs.slice(0, 3).join(', ') + (xs.length > 3 ? ` +${xs.length - 3} more` : '');
    const missing = links.filter((l) => !noteNames.has(leaf(l)));
    const noted = links.filter((l) => noteNames.has(leaf(l)));
    const parts = [`Not saved to those links: ${list(links)}.`];
    if (missing.length) parts.push(`No note in this world is named ${list(missing)}: create it or correct the link.`);
    if (noted.length) parts.push(`${list(noted)} ${noted.length === 1 ? 'has a note' : 'have notes'} with no element id yet, or of another type than the field takes.`);
    parts.push('Then save again.');
    return parts.join(' ');
}

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
    /** This device cannot tell a never-uploaded note from a deleted one (the feed read failed, the server was restored, or keel asks for a re-read). */
    cannotTell?: boolean;
    cannotTellReason?: CannotTellReason;
    /** The ids of `leftOut`: stripped from this save's link fields (Kael's second read, N5). */
    leftOutIds?: string[];
    /** A target that cannot be sent whole (an unclosed code fence): nothing is created or saved, and this says why. */
    refused?: string;
    /** Targets created first whose own [[links]] no element id answers, each with those links (round C, 14: Kael's low 10). */
    targetLinks?: string[];
}

const NO_PLAN: CreateFirstPlan = { firsts: [], leftOut: [] };

/** The world id the key names, "" when it cannot be read (a 410's recreate takes it off the deleted list). */
async function worldIdOf(client: { getWorld(): Promise<Record<string, unknown>> }): Promise<string> {
    try {
        const id = (await client.getWorld()).id;
        return typeof id === 'string' ? id : '';
    } catch {
        return '';
    }
}

/** Note path and key of each likely-misnamed key auto-sync has named this session (round C, 4). */
const misnamedShown = new Set<string>();

/** Note paths whose unclosed-fence refusal auto-sync has shown this session (the fix round, item 1). */
const fenceShown = new Set<string>();

/** Note paths whose hidden refusal auto-sync has shown this session (OW Infra #426). */
const hiddenShown = new Set<string>();

/** Note paths whose left-view refusal auto-sync has shown this session (Kael's read, h37 #8212). */
const leftViewShown = new Set<string>();

/** Note paths whose known-of notice auto-sync has shown this session (OW Infra #454). */
const knownOfShown = new Set<string>();

// Element ids whose new name auto-sync saved without renaming the note live
// in the plugin's data (settings.pendingRenames, per world folder), so the
// next Save Element renames the note, even when nothing else changed and
// after a restart (the fix round, item 6: N7; Kael's fixes read, low 5).

/** What auto-sync adds to its saved notice when the note keeps its old name. */
const KEEPS_OLD_NAME = ' The note keeps its old name; Save Element renames it.';

/** Why a save stopped before its creates: a target refused, past the cap, or the dialog cancelled. */
function stopMessage(plan: CreateFirstPlan): string {
    if (plan.refused) return `${plan.refused} Nothing was created or saved.`;
    return plan.overflow ? OVERFLOW_MESSAGE : CANCELLED_MESSAGE;
}

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

/** What a save adds to its notice about the create-first batch: replaced ids and targets' links left out (round C, 14). */
function createFirstNotes(replaced: string[], plan: CreateFirstPlan): string {
    const parts: string[] = [];
    if (replaced.length > 0) {
        const one = replaced.length === 1;
        parts.push(
            `${replaced.join(', ')} ${one ? 'was' : 'were'} already on onlyworlds.com (made meanwhile, perhaps on another device) ` +
            `and ${one ? 'was' : 'were'} replaced by ${one ? 'its note' : 'their notes'} here.`
        );
    }
    if (plan.targetLinks?.length) {
        parts.push(`Links not sent, as no element id answers them: ${plan.targetLinks.join('; ')}. Fix them and save those notes.`);
    }
    return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Auto-sync's addition to keel's refusal of a link to an element it does not
 * have (400 invalid_link, elements/resolve.py): the manual Save creates such
 * targets first, auto-sync never does (Kael's read, blocker).
 */
function missingLinkHint(error: unknown, manual: boolean): string {
    if (manual || !(error instanceof V2ApiError) || error.code !== 'invalid_link') return '';
    return ' A link names an element onlyworlds.com does not have: Save Element creates it first if it is new, or leaves it out if it was deleted there.';
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

/**
 * `fields` with the given element ids taken out of its link fields: a single
 * link holding one is dropped from the payload (the server keeps its value), a
 * multi-link loses it from its list. Other fields are untouched.
 */
export function withoutLinks(type: string, fields: Record<string, unknown>, ids: string[] | undefined): Record<string, unknown> {
    if (!ids || ids.length === 0) return fields;
    const drop = new Set(ids);
    const schema = getCategorySchema(type);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
        const def = schema?.[key];
        if (def?.type === 'single_link' && typeof value === 'string' && drop.has(value)) continue;
        out[key] = def?.type === 'multi_link' && Array.isArray(value)
            ? value.filter((v) => !(typeof v === 'string' && drop.has(v)))
            : value;
    }
    return out;
}

/**
 * The walk's targets with every left-out id taken out of their own links, at
 * the last moment before the /bulk: an id is left out wherever the walk met
 * it, and a later sibling can add one after a target was found (Kael's third
 * read, 3: Barovia went with deleted Vallaki's id and sank Ireena's save).
 */
function strippedFirsts(plan: CreateFirstPlan): PendingCreate[] {
    return plan.firsts.map((f) => ({ ...f, payload: withoutLinks(f.type, f.payload, plan.leftOutIds) }));
}

/** The notice for links a save left out because their targets were deleted (N5) or hidden by the world's owner (OW Infra #426). */
function leftOutNotice(plan: CreateFirstPlan): void {
    const say = (items: CreateFirstItem[], why: string) => {
        if (items.length === 0) return;
        const lines = items.map((i) => `${capitalize(i.type)} "${i.name}"`).join(', ');
        new Notice(`${lines} ${items.length === 1 ? 'was' : 'were'} ${why}: the link is left out of this save, and the note keeps it.`, 12000);
    };
    say(plan.leftOut.filter((i) => !i.hidden && !i.leftView), 'deleted on onlyworlds.com');
    say(plan.leftOut.filter((i) => i.hidden), "hidden by the world's owner");
    say(plan.leftOut.filter((i) => i.leftView), 'no longer in your view');
}

/**
 * `{ hidden: true }` for an id the world's owner hid, `{ leftView: true }` for
 * one a role reset left out of view, else nothing: a deleted item keeps its
 * shape (OW Infra #426; Kael's read, h37 #8212).
 */
function hiddenMark(hidden: Set<string> | undefined, id: string, leftView?: Set<string>): { hidden?: true; leftView?: true } {
    if (hidden?.has(id)) return { hidden: true };
    return leftView?.has(id) ? { leftView: true } : {};
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
        if (v2?.id && (await this.isHidden(activeFile, v2.id))) return this.hiddenRefusal(activeFile, manual);
        // A known-of note is never sent, by any path (the folder spec §4.4
        // rule 3, OW Infra #454): before any read of the server, so no create,
        // re-create or update can follow.
        if (v2?.knownOf) return this.knownOfRefusal(activeFile, manual);
        // A whole note kept as last known: keel serves its element as a stub
        // now, and a diff against that stub would read its blanks as values
        // (rule 2). Refused up front, as a known-of note is (h37 #8936, 4).
        if (v2?.id && isLastKnownId(this.plugin.settings, v2.id)) return this.knownOfRefusal(activeFile, manual, LAST_KNOWN_NOT_SAVED);
        if (v2 && v2.id) {
            // A fence that never closes swallowed the sections after it: the
            // note is refused, never sent cut short (round C, 1).
            // Auto-sync says it once a session per note, not at every pause;
            // the status bar still shows the error (the fix round, item 1).
            if (v2.unclosedFence) {
                const reason = unclosedFenceMessage(v2.name, v2.unclosedFence);
                if (!manual && fenceShown.has(activeFile.path)) return { ok: false, reason };
                if (!manual) fenceShown.add(activeFile.path);
                return this.fail(reason, 15000);
            }
            elementData = { id: v2.id, ...v2.fields };
            // A key one slip from a link field went out as x_<key>: say which
            // field it likely meant, correct nothing (round C, 4). Auto-sync
            // says it once a session per note and key, not at every pause.
            const slips = (v2.likelyMisnamed ?? []).filter((s) => {
                if (manual) return true;
                const seen = `${activeFile.path}|${s.key}`;
                if (misnamedShown.has(seen)) return false;
                misnamedShown.add(seen);
                return true;
            });
            if (slips.length > 0) new Notice(likelyMisnamedMessage(v2.category, slips), 12000);
            // A [[Name]] no element id answers is left out, its whole field
            // omitted so the server's copy is not stripped. Saying nothing
            // means "saved" while the link did not travel: name the links and
            // the fix. Upload World resolves links the same way, so it never
            // helps here and is not named (round C, 10).
            if (v2.unresolvedLinks.length > 0) {
                new Notice(unresolvedLinksMessage([...new Set(v2.unresolvedLinks)], this.worldNoteNames(worldName)), 12000);
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
        if (!v2?.id && isHiddenId(this.plugin.settings, elementUuid)) return this.hiddenRefusal(activeFile, manual);

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
            const gone = this.isGone(error);
            if (gone || this.isNotFound(error)) {
                try {
                    // A 404 is "never uploaded" or "deleted on the server". The
                    // deleted list, with the feed read on from the session's
                    // cursor (or Download's, or the start), tells them apart:
                    // a deleted element is never recreated by auto-sync, and
                    // only on the user's word by Save Element
                    // (Kael's second read, N1). A 410 is keel saying this
                    // world deleted it: no feed read (OW Infra #403).
                    // A note a role reset kept: keel answers its id 404, and
                    // it is never created again (Kael's read, h37 #8212).
                    if (!gone && isLeftViewId(this.plugin.settings, elementUuid)) return this.leftViewRefusal(activeFile, manual);
                    const view = gone ? null : await readDeletedOnServer(this.plugin, client);
                    // The feed says the world's owner hid it: never created
                    // again, never asked (OW Infra #426).
                    if (view?.hidden.has(elementUuid)) return this.hiddenRefusal(activeFile, manual);
                    let recreated = false;
                    if (!view || view.ids.has(elementUuid)) {
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
                    } else if (!view.known) {
                        // This device cannot tell "never uploaded" from "deleted"
                        // (Kael's third read, 2). A failed feed read: auto-sync
                        // waits for its next tick. A restored server or keel's
                        // resync_required: auto-sync points to Download World.
                        // The manual Save asks, saying why. (A device with no
                        // stored cursor reads the feed from the start, 3b68635,
                        // so it can tell.)
                        if (!manual && view.reason === 'failed') {
                            return this.fail(
                                `Could not check onlyworlds.com for a delete of ${label}; not created this time. Auto-sync tries again on the next edit.`,
                                8000
                            );
                        }
                        if (!manual && view.reason === 'rewound') {
                            return this.fail(
                                `onlyworlds.com was restored from a backup since this device's last Download, so ${label} was not created: run Download World.`,
                                10000
                            );
                        }
                        if (!manual && view.reason === 'resync') {
                            return this.fail(
                                `onlyworlds.com asks this device to read the world again, so ${label} was not created: Download World to catch up.`,
                                10000
                            );
                        }
                        if (manual) {
                            const go = await confirm(
                                this.app,
                                `Create ${capitalize(type)} "${label}" on onlyworlds.com?`,
                                [cannotTellLine(view.reason)],
                                'Create'
                            );
                            if (!go) return this.fail(CANCELLED_MESSAGE);
                        }
                    }
                    // Link targets that are notes in this vault but not on the
                    // server go first, or keel refuses the note (row 8).
                    // Only the manual Save walks (Kael's read, blocker): auto-sync
                    // leaves keel's refusal and says how to get past it.
                    // Auto-sync walks nothing, but leaves out a link to an
                    // element the view this 404 read names deleted, a note
                    // here or not (Kael's fixes read, low 4).
                    const plan = manual
                        ? await this.unsyncedTargets(client, worldName, elementUuid, type, payload, undefined, view ?? undefined)
                        : this.leftOutOf(worldName, type, payload, () => true, view?.ids ?? new Set(), view?.hidden, view?.leftView);
                    if (!(await this.approveCreateFirst(String(label), plan))) {
                        return this.fail(stopMessage(plan), plan.refused ? 15000 : plan.overflow ? 12000 : undefined);
                    }
                    const firsts = plan.firsts;
                    // A link to a deleted element is left out of what is sent;
                    // the note keeps it (Kael's second read, N5).
                    const sendPayload = withoutLinks(type, payload, plan.leftOutIds);
                    leftOutNotice(plan);
                    new Notice(`Creating ${category} "${label}"...`);
                    if (firsts.length > 0) {
                        const together = await this.createTogether(client, [
                            ...strippedFirsts(plan),
                            { type, id: elementUuid, name: String(label), payload: sendPayload },
                        ]);
                        if (together.refused) return this.fail(`Failed to create ${category}: ${together.refused}`, 12000);
                        if (recreated) await forgetDeleted(this.plugin, view?.worldId ?? (await worldIdOf(client)), [elementUuid]);
                        const extra = createFirstNotes(together.replaced, plan);
                        new Notice(`${createdFirstMessage(firsts)} ${category} created.${extra}`, extra ? 15000 : 8000);
                        return { ok: true, outcome: 'created' };
                    }
                    await client.create(type, { id: elementUuid, ...sendPayload });
                    if (recreated) await forgetDeleted(this.plugin, view?.worldId ?? (await worldIdOf(client)), [elementUuid]);
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

        // A value that differs from the server's only by a backslash the
        // read took off a `###` or fence line (a note from before the escape
        // holds `\### x` as typed) keeps the server's value (the keeper's
        // amendment to items 1 and 3).
        const changed = keepServerEscapes(diffPayload(payload, current ?? {}), current ?? {});
        if (Object.keys(changed).length === 0) {
            const renameNote = await this.pendingRenameNote(activeFile, worldName, elementUuid, elementData.name, manual);
            new Notice(`${category} "${label}" already up to date.${renameNote}`, renameNote ? 8000 : undefined);
            return { ok: true, outcome: 'unchanged' };
        }

        try {
            new Notice(`Saving ${category} "${label}"...`);
            // A link this save adds may name a note not on the server yet:
            // create those first (row 8). Only ids the server's copy lacks are
            // looked up, so an unchanged link costs nothing.
            // Auto-sync walks nothing, but leaves out a link to an element the
            // stored deleted list names, without a feed read (third read, 4).
            const addedLink = (key: string, id: string) => !linkHolds(current?.[key], id);
            const plan = manual
                ? await this.unsyncedTargets(client, worldName, elementUuid, type, changed, addedLink)
                : await this.storedLeftOut(client, worldName, type, changed, addedLink);
            let firstNote = '';
            let firstExtra = '';
            if (!(await this.approveCreateFirst(String(label), plan))) {
                return this.fail(stopMessage(plan), plan.refused ? 15000 : plan.overflow ? 12000 : undefined);
            }
            const firsts = plan.firsts;
            // A link to a deleted element is left out of the PATCH, so keel
            // does not refuse the note's other edits; the note keeps the link
            // (Kael's second read, N5). What then equals the server's copy is
            // not sent at all.
            const toSend = plan.leftOutIds?.length
                ? diffPayload(withoutLinks(type, changed, plan.leftOutIds), current ?? {})
                : changed;
            leftOutNotice(plan);
            if (Object.keys(toSend).length === 0) {
                const renameNote = await this.pendingRenameNote(activeFile, worldName, elementUuid, elementData.name, manual);
                new Notice(`${category} "${label}" already up to date.${renameNote}`, renameNote ? 8000 : undefined);
                return { ok: true, outcome: 'unchanged' };
            }
            if (firsts.length > 0) {
                const together = await this.createTogether(client, strippedFirsts(plan));
                if (together.refused) return this.fail(`${category} "${label}" not saved: ${together.refused}`, 12000);
                firstExtra = createFirstNotes(together.replaced, plan);
                firstNote = `${createdFirstMessage(firsts)}${firstExtra} `;
            }
            await client.update(type, elementUuid, toSend);
            // Only the manual Save renames: auto-sync fires at every pause while
            // a name is typed, and each rename can rewrite every linking note
            // (Kael's read, 7). Auto-sync records the rename it did not make,
            // and the next Save Element makes it (the fix round, item 6).
            let renameNote = '';
            if (manual && typeof changed.name === 'string') {
                await this.setPendingRename(worldName, elementUuid, false);
                const renamed = await this.renameToName(activeFile, changed.name, elementUuid);
                renameNote = renamed ? ` Note renamed to "${renamed}".` : '';
            } else if (manual) {
                renameNote = await this.pendingRenameNote(activeFile, worldName, elementUuid, elementData.name, manual);
            } else if (typeof changed.name === 'string' && this.wouldRename(activeFile, changed.name)) {
                await this.setPendingRename(worldName, elementUuid, true);
                renameNote = KEEPS_OLD_NAME;
            }
            new Notice(`${firstNote}${category} saved.${renameNote}`, firstExtra ? 15000 : firstNote || renameNote ? 8000 : undefined);
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
        const leftOutIds: string[] = [];
        const visited = new Set<string>([rootId]);
        let index: Map<string, TFile> | null = null;
        let view: DeletedView | null = known ?? null;
        let overflow = false;
        let refused: string | undefined;
        const targetLinks: string[] = [];
        let found = 0;
        const visit = async (type: string, payload: Record<string, unknown>, filter?: typeof keep): Promise<void> => {
            for (const id of linkIdsOf(type, payload, filter)) {
                if (overflow) return;
                if (visited.has(id)) continue;
                visited.add(id);
                index = index ?? this.worldNoteIndex(worldName);
                const file = index.get(id);
                if (!file) {
                    // A raw id with no note here: nothing to create, but one
                    // the feed reports deleted is left out and named, as
                    // Upload World does, or keel refuses the whole save (the
                    // fix round, item 8; Kael's delta read, E-8a).
                    view = view ?? (await readDeletedOnServer(this.plugin, client));
                    if (view.ids.has(id)) {
                        leftOut.push({ type: 'element', name: id, ...hiddenMark(view.hidden, id, view.leftView) });
                        leftOutIds.push(id);
                    }
                    continue;
                }
                const parsed = await readElement(this.app, file);
                if (!parsed || parsed.id !== id) continue;
                try {
                    await client.get(parsed.category, id);
                    continue; // already on the server
                } catch (error) {
                    // A 410: keel says this world deleted it, so it is left
                    // out as a feed-reported delete is, with no feed read
                    // (OW Infra #403). Any other non-404 stays "on the server".
                    if (this.isGone(error)) {
                        leftOut.push({ type: parsed.category, name: parsed.name });
                        leftOutIds.push(id);
                        continue;
                    }
                    if (!this.isNotFound(error)) continue;
                }
                // A 404 is "never pushed" or "deleted": an id the change feed
                // reported deleted is never recreated (Kael's read, blocker 1c).
                // The first 404 reads the feed on from the session's cursor (or
                // Download's, or the start), so a delete no Download has seen
                // yet counts too (second read, N3; delta read, low 1).
                view = view ?? (await readDeletedOnServer(this.plugin, client));
                if (view.ids.has(id)) {
                    leftOut.push({ type: parsed.category, name: parsed.name, ...hiddenMark(view.hidden, id, view.leftView) });
                    leftOutIds.push(id);
                    continue;
                }
                // A stub is never created first, even with the hidden list
                // lost: its fields are not the element's (OW Infra #426).
                if (await this.isHidden(file, id)) {
                    leftOut.push({ type: parsed.category, name: file.basename, hidden: true });
                    leftOutIds.push(id);
                    continue;
                }
                // A known-of target is never created from its stub. One keel
                // serves stays linked (the GET above answered); one it answers
                // 404 for, not deleted, is out of this reader's view: the link
                // is left out, or keel refuses the whole save (h37 #8936, 1).
                if (parsed.knownOf) {
                    leftOut.push({ type: parsed.category, name: parsed.name, leftView: true });
                    leftOutIds.push(id);
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
                // A target whose fence never closes would be created cut short
                // (round C, 1): the save stops and names it.
                if (parsed.unclosedFence) {
                    refused = unclosedFenceMessage(`${capitalize(parsed.category)} "${parsed.name}"`, parsed.unclosedFence);
                    overflow = true;
                    return;
                }
                const targetPayload = toV2Payload(parsed.fields);
                await visit(parsed.category, targetPayload);
                if (overflow) return;
                out.push({ type: parsed.category, id, name: parsed.name, payload: targetPayload });
                const dropped = [...new Set([...parsed.unresolvedLinks, ...parsed.ambiguousLinks])];
                if (dropped.length > 0) targetLinks.push(`${capitalize(parsed.category)} "${parsed.name}" (${dropped.join(', ')})`);
            }
        };
        await visit(rootType, rootPayload, keep);
        if (refused) return { firsts: [], leftOut, leftOutIds, refused };
        return { firsts: out, leftOut, leftOutIds, overflow, targetLinks, cannotTell: view ? !view.known : false, cannotTellReason: view?.reason };
    }

    /**
     * Before the creates: ask when there is something to create (the dialog
     * also lists what is left out), else name what is left out in a notice.
     * True means go on with the save.
     */
    private async approveCreateFirst(label: string, plan: CreateFirstPlan): Promise<boolean> {
        if (plan.overflow || plan.refused) return false;
        if (plan.firsts.length > 0) return this.confirmCreateFirst(label, plan);
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
        if (!this.wouldRename(file, name)) return null;
        const base = sanitizeFileName(name);
        const current = file.basename;
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

    /** Record (or clear) a rename auto-sync left for Save Element, in the plugin's data; a failed write keeps it for this run. */
    private async setPendingRename(worldName: string, id: string, pending: boolean): Promise<void> {
        const all = this.plugin.settings.pendingRenames ?? {};
        const list = all[worldName] ?? [];
        if (list.includes(id) === pending) return;
        this.plugin.settings.pendingRenames = {
            ...all,
            [worldName]: pending ? [...list, id] : list.filter((x) => x !== id),
        };
        try {
            await this.plugin.saveSettings?.();
        } catch {
            /* kept in memory for this run */
        }
    }

    /** True when renameToName would rename `file` for `name`: the setting is on and the file does not carry the name yet. */
    private wouldRename(file: TFile, name: string): boolean {
        if (this.plugin.settings.renameNoteOnNameChange === false) return false;
        const base = sanitizeFileName(name);
        const current = file.basename;
        return !(current === base || (current.startsWith(`${base} (`) && /\(\d+\)$/.test(current)));
    }

    /**
     * The manual Save's rename of a note whose new name auto-sync already
     * sent (settings.pendingRenames), and what the notice adds for it; '' when there is
     * none, or on auto-sync (the fix round, item 6).
     */
    private async pendingRenameNote(file: TFile, worldName: string, id: string, name: unknown, manual: boolean): Promise<string> {
        if (!manual || !(this.plugin.settings.pendingRenames?.[worldName] ?? []).includes(id)) return '';
        await this.setPendingRename(worldName, id, false);
        if (typeof name !== 'string' || !name) return '';
        const renamed = await this.renameToName(file, name, id);
        return renamed ? ` Note renamed to "${renamed}".` : '';
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
                plan.cannotTell === true,
                plan.cannotTellReason ?? 'failed'
            ).open();
        });
    }

    /**
     * Auto-sync's plan: no targets to create, only the links this save adds
     * to elements the stored deleted list names (no feed read), left out of
     * the PATCH and named by their notes (Kael's third read, 4).
     */
    private async storedLeftOut(
        client: { getWorld(): Promise<Record<string, unknown>> },
        worldName: string,
        type: string,
        fields: Record<string, unknown>,
        keep: (key: string, id: string) => boolean
    ): Promise<CreateFirstPlan> {
        if (linkIdsOf(type, fields, keep).length === 0) return NO_PLAN;
        const stored = await storedDeleted(this.plugin, client);
        return this.leftOutOf(worldName, type, fields, keep, stored.ids, stored.hidden, stored.leftView);
    }

    /**
     * The plan that leaves out the links of `fields` (narrowed by `keep`) to ids
     * in `deleted`, each named by its note or its id; those in `hidden` are
     * named as hidden by the world's owner (OW Infra #426).
     */
    private leftOutOf(
        worldName: string,
        type: string,
        fields: Record<string, unknown>,
        keep: (key: string, id: string) => boolean,
        deleted: Set<string>,
        hidden?: Set<string>,
        leftView?: Set<string>
    ): CreateFirstPlan {
        const hit = [...new Set(linkIdsOf(type, fields, keep))].filter((id) => deleted.has(id));
        if (hit.length === 0) return NO_PLAN;
        const index = this.worldNoteIndex(worldName);
        const leftOut = hit.map((id) => {
            const file = index.get(id);
            const cat = file ? this.extractPathInfo(file.path)?.category.toLowerCase() : undefined;
            return { type: cat ?? 'element', name: file?.basename ?? id, ...hiddenMark(hidden, id, leftView) };
        });
        return { firsts: [], leftOut, leftOutIds: hit };
    }

    /** True when the note is a stub, or its id is on a hidden list: never sent (OW Infra #426). */
    private async isHidden(file: TFile, id: string): Promise<boolean> {
        if (isHiddenId(this.plugin.settings, id)) return true;
        try {
            return isStubNote(await this.app.vault.read(file));
        } catch {
            return false;
        }
    }

    /** A save of a note a role reset kept: refused and said; auto-sync says it once a session per note. */
    private leftViewRefusal(file: TFile, manual: boolean): SaveResult {
        if (!manual && leftViewShown.has(file.path)) return { ok: false, reason: LEFT_VIEW_NOT_SAVED };
        if (!manual) leftViewShown.add(file.path);
        return this.fail(LEFT_VIEW_NOT_SAVED, 8000);
    }

    /**
     * A save of a known-of note: nothing sent, and said; Save Element says it
     * each time it is asked, auto-sync once a session per note. Not an error:
     * the edits are the person's, kept in this vault (OW Infra #454).
     */
    private knownOfRefusal(file: TFile, manual: boolean, reason: string = KNOWN_OF_NOT_SAVED): SaveResult {
        const local = { ok: false as const, reason, local: true as const };
        if (!manual && knownOfShown.has(file.path)) return local;
        if (!manual) knownOfShown.add(file.path);
        new Notice(reason, 8000);
        return local;
    }

    /** A save of a hidden element: refused and said; auto-sync says it once a session per note. */
    private hiddenRefusal(file: TFile, manual: boolean): SaveResult {
        if (!manual && hiddenShown.has(file.path)) return { ok: false, reason: HIDDEN_NOT_SAVED };
        if (!manual) hiddenShown.add(file.path);
        return this.fail(HIDDEN_NOT_SAVED, 8000);
    }

    /** The file names (lower case) of this world's element notes, for the unresolved-link notice. */
    private worldNoteNames(worldName: string): Set<string> {
        const prefix = `OnlyWorlds/Worlds/${worldName}/Elements/`;
        const names = new Set<string>();
        for (const f of this.app.vault.getMarkdownFiles()) {
            if (f.path.startsWith(prefix)) names.add(f.basename.toLowerCase());
        }
        return names;
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
     * Sent atomic (round C, 14: Kael's low 8): one refused item writes none,
     * so a failed save leaves no half of its batch behind. `refused` is null
     * when every item landed, else the refused items with keel's reasons.
     * `replaced` names the items that answered 200: the id appeared on the
     * server meanwhile, and /bulk with an id replaces it whole (Kael's low 9).
     */
    private async createTogether(
        client: { bulkCreate(items: { type: string; element: Record<string, unknown> }[], opts?: { atomic?: boolean }): Promise<Record<string, unknown>> },
        items: PendingCreate[]
    ): Promise<{ refused: string | null; replaced: string[] }> {
        const body = await client.bulkCreate(
            items.map((i) => ({ type: i.type, element: { id: i.id, ...i.payload } })),
            { atomic: true }
        );
        const results = Array.isArray(body?.items) ? (body.items as unknown[]) : [];
        const refused: string[] = [];
        const replaced: string[] = [];
        items.forEach((item, i) => {
            const r = (results[i] ?? null) as { status?: unknown; error?: { message?: unknown } } | null;
            const status = typeof r?.status === 'number' ? r.status : null;
            if (status === 201) return;
            if (status === 200) {
                replaced.push(`${capitalize(item.type)} "${item.name}"`);
                return;
            }
            const why = typeof r?.error?.message === 'string'
                ? r.error.message
                : status !== null ? `status ${status}` : 'no result from the server';
            refused.push(`${capitalize(item.type)} "${item.name}": ${why}`);
        });
        // An atomic batch reports each slot as it would have gone: `errors`
        // is the word that nothing was written.
        if (refused.length === 0 && body?.errors === true) refused.push('the batch was refused as a whole, nothing was written');
        return { refused: refused.length > 0 ? refused.join('; ') : null, replaced };
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

    // keel answers 410 `gone` on a GET of an id this world deleted as this
    // type (a never-uploaded id, another type, a guest key and v1 still get
    // 404): the server has said "deleted", no feed read needed (OW Infra #403).
    private isGone(error: unknown): boolean {
        return error instanceof V2ApiError && error.status === 410;
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
