import { requestUrl, RequestUrlParam } from "obsidian";
import { toV2WireKeys } from "./vault/element-transform";

/**
 * Minimal OnlyWorlds v2 API client over Obsidian's requestUrl().
 *
 * Dialect notes (frozen against keel v2, verified on the wire 2026-07-13):
 * - Base: https://www.onlyworlds.com/api/v2 — slash-tolerant routes.
 * - Auth: API-Key / API-Pin headers (same pair the v1 client used).
 * - List envelope: `{ "data": [...] }` — NOT v1's {count,next,previous,results}.
 * - Changes feed: GET /changes?since=<cursor>&limit=N →
 *   { cursor, changes: [{ op: "upsert"|"delete", type, id, change_seq, updated_at, element }] }.
 *   Resume param is `since`; passing `cursor` as a param name silently replays
 *   from the epoch (same trap Atlas documents in its adapter).
 * - Link fields on the wire are bare schema names (no _id/_ids suffixes).
 * - Extension-namespaced fields (atlas_*, shadow_*, x_*) are legal wire data.
 * - Errors: { "error": { type, code, message, param, doc_url } }.
 *
 * The @onlyworlds/sdk stays in the plugin as schema authority (FIELD_SCHEMA,
 * type metadata) but is v1-only for transport; this client replaces it on the wire.
 */

const V2_BASE = "https://www.onlyworlds.com/api/v2";
/** The server the v2 client speaks to, as a folder's `source.server` names it (spec §4.2). */
export const V2_ORIGIN = new URL(V2_BASE).origin;

/**
 * v1-parse output → v2 wire payload. The span-tag parsers emit link keys with
 * the v1 write suffixes (`location_id`, `abilities_ids`); v2 speaks bare
 * schema names and loud-422s unknown fields. `world`/`world_id` are stripped
 * (world identity is the API key).
 */
export function toV2Payload(element: Record<string, unknown>): Record<string, unknown> {
    // The rule lives in the transform (testable without Obsidian); Pin's
    // element_type/element_id keep their names there (keel 422s `element`).
    return toV2WireKeys(element);
}

export interface V2Change {
    op: "upsert" | "delete";
    type: string;
    id: string;
    change_seq: number;
    updated_at: string;
    element?: Record<string, unknown>;
    /**
     * On a delete row while keel's hidden mark is on (D124): `deleted` (a
     * tombstone) or `hidden` (the world's owner hid it from this reader:
     * sync/hidden-on-server.ts). Absent with the mark off.
     */
    reason?: string;
}

export interface V2ChangesPage {
    cursor: string | null;
    changes: V2Change[];
    has_more: boolean;
    /** Highest change_seq on the server — persists alongside the cursor;
     *  a later head LOWER than the stored one means a server restore-from-backup
     *  (rewind), and the caller should cold-rewalk from the epoch. */
    head: number;
}

export class V2ApiError extends Error {
    status: number;
    code: string;
    docUrl: string | null;
    /**
     * Why keel answered so, when it says: the 409 `resync_required` carries
     * `role` or `view` while the hidden mark is on (D127). Read inside the
     * error envelope or beside it; null when neither holds a string.
     */
    reason: string | null;
    /** The field keel names in its error (`API-Pin` on a refused or counted PIN); null when it names none. */
    param: string | null;

    constructor(status: number, code: string, message: string, docUrl: string | null, reason: string | null = null, param: string | null = null) {
        super(message);
        this.name = "V2ApiError";
        this.status = status;
        this.code = code;
        this.docUrl = docUrl;
        this.reason = reason;
        this.param = param;
    }
}

/** A response body kept in a message: its first 200 characters, whitespace folded (the whole of a page once filled a notice, 221,349 characters: Keel #1641). */
function shortBody(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > 200 ? flat.slice(0, 200) + "…" : flat;
}

/**
 * The web host in front of OnlyWorlds answers some writes itself (Keel #1641): a 403 with an HTML page titled "Blocked" when a text holds a
 * command such as python -m right after a backtick (a semicolon or a pipe too), a fence with no language word, or a table cell. keel never sees
 * the request. Null when the body is not a page.
 */
function hostAnswer(status: number, text: string): { code: string; message: string } | null {
    if (!text || !text.trimStart().startsWith("<")) return null;
    // The page the host's rule gives is titled "Blocked"; any other page (a challenge, another rule, a gateway error) is only said to be the host's.
    if (status === 403 && /<title>\s*Blocked\s*<\/title>/i.test(text)) {
        return {
            code: "host_refused",
            message:
                "The web host in front of OnlyWorlds refused this before it reached OnlyWorlds (HTTP 403, a page titled Blocked). " +
                "One known cause: a command such as python -m or curl directly after a backtick, a semicolon or a pipe. " +
                "Write it in a code block with a language word, or after a $ prompt.",
        };
    }
    return { code: "host_page", message: `The web host in front of OnlyWorlds answered with a page, not data (HTTP ${status}).` };
}

/** The `If-Match` header for a change_seq, quoted as an entity tag; none for a seq that is not a whole number. */
function ifMatchHeader(seq: number | null | undefined): Record<string, string> | undefined {
    return typeof seq === "number" && Number.isInteger(seq) && seq >= 0 ? { "If-Match": `"${seq}"` } : undefined;
}

/** True when keel refused a write because the element moved past the If-Match change_seq (412 precondition_failed). */
export function isStaleWrite(error: unknown): boolean {
    return error instanceof V2ApiError && error.status === 412;
}

/**
 * The reason one /bulk slot was refused, as a sentence for the person. A held
 * id (`id_conflict`, a create-only batch) is said in the plugin's words, by
 * which of keel's four 409s it is (elements/service.py: held_conflict, one
 * builder per sentence): the id held in this world as the same type or as
 * another type, held in another world, or in use by a membership. keel's own
 * text names the id and the PUT road, which a person has neither use for nor a
 * way to take; the remedy a person can take (a new id on the note) is kept.
 * A hidden id never answers 409 (keel gives it the missing-id 404), so none of
 * these says "hidden". Anything else is keel's message, else the status.
 */
export function bulkSlotWhy(r: { status?: unknown; error?: { code?: unknown; message?: unknown } } | null): string {
    if (r?.error?.code === "id_conflict") {
        const said = typeof r.error.message === "string" ? r.error.message : "";
        const asType = /already exists as an? ([\w-]+) in this world/.exec(said);
        if (asType) return `its id already belongs to a ${asType[1]} on onlyworlds.com; nothing there was replaced`;
        if (/another world/.test(said)) {
            return "its id is already taken by an element in another world (a copied world folder needs fresh ids): give this note a new id; nothing was sent";
        }
        if (/already in use/.test(said)) return "its id is already in use on onlyworlds.com: give this note a new id; nothing was sent";
        if (/already exists/.test(said)) {
            return "an element with its id was made on onlyworlds.com meanwhile (on another device, perhaps); nothing there was replaced";
        }
        return "its id is already held on onlyworlds.com; nothing there was replaced";
    }
    if (typeof r?.error?.message === "string") return r.error.message;
    return typeof r?.status === "number" ? `status ${r.status}` : "no result from the server";
}

export class V2Client {
    private headers: Record<string, string>;
    private onPinRefused?: () => void;

    /**
     * `onPinRefused` is called once per answer in which keel refuses the PIN
     * this client sent: a 401 whose `param` is `API-Pin` (server rule of 2026-11-21:
     * a wrong PIN is a 401 each time, and the same wrong PIN sent again never
     * locks anything, so the plugin forgets it instead of sending it with every
     * later save).
     */
    constructor(apiKey: string, apiPin: string, opts?: { onPinRefused?: () => void }) {
        this.headers = {
            "Content-Type": "application/json",
            "API-Key": apiKey,
            "API-Pin": apiPin,
        };
        this.onPinRefused = opts?.onPinRefused;
    }

    private async request<T>(
        method: string,
        path: string,
        params?: Record<string, string | number | undefined>,
        body?: unknown,
        extraHeaders?: Record<string, string>
    ): Promise<T> {
        const url = new URL(`${V2_BASE}${path}`);
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.append(key, String(value));
                }
            }
        }

        const req: RequestUrlParam = {
            url: url.toString(),
            method,
            headers: extraHeaders ? { ...this.headers, ...extraHeaders } : this.headers,
            throw: false,
        };
        if (body !== undefined && ["POST", "PATCH", "PUT"].includes(method)) {
            req.body = JSON.stringify(body);
        }

        const response = await requestUrl(req);

        if (response.status >= 400) {
            // Keel error envelope: { error: { code, message, doc_url, ... } }
            let code = `http_${response.status}`;
            let message = `API error ${response.status}`;
            let docUrl: string | null = null;
            let reason: string | null = null;
            let param: string | null = null;
            try {
                const parsed = JSON.parse(response.text);
                if (parsed && typeof parsed === "object" && parsed.error) {
                    code = parsed.error.code ?? code;
                    message = parsed.error.message ?? message;
                    docUrl = parsed.error.doc_url ?? null;
                    param = typeof parsed.error.param === "string" ? parsed.error.param : null;
                    const envelope = parsed as { reason?: unknown; error: { reason?: unknown } };
                    const why = envelope.error.reason ?? envelope.reason;
                    reason = typeof why === "string" ? why : null;
                } else if (response.text) {
                    message += `: ${shortBody(response.text)}`;
                }
            } catch {
                // Not JSON, so not keel: keel answers JSON to everything. A page (it starts with "<") is the web host's own answer, said in one line.
                const hostWords = hostAnswer(response.status, response.text);
                if (hostWords) {
                    code = hostWords.code;
                    message = hostWords.message;
                } else if (response.text) {
                    message += `: ${shortBody(response.text)}`;
                }
            }
            if (response.status === 401 && param === "API-Pin") this.onPinRefused?.();
            throw new V2ApiError(response.status, code, message, docUrl, reason, param);
        }

        if (response.status === 204) {
            return undefined as unknown as T;
        }
        return response.json as T;
    }

    async getWorld(): Promise<Record<string, unknown>> {
        return this.request("GET", "/world");
    }

    /** PATCH /world: owner only; send only the world fields you mean to change. */
    async patchWorld(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.request("PATCH", "/world", undefined, payload);
    }

    async get(type: string, id: string): Promise<Record<string, unknown>> {
        return this.request("GET", `/${type}/${id}`);
    }

    async create(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.request("POST", `/${type}`, undefined, payload);
    }

    /**
     * PATCH — send only the fields you parsed; the server merges. With
     * `ifMatch` (the change_seq the note was last pulled or saved at), keel
     * applies it only if the element has not moved since, else answers 412
     * `precondition_failed` and writes nothing.
     */
    async update(
        type: string,
        id: string,
        payload: Record<string, unknown>,
        opts?: { ifMatch?: number | null }
    ): Promise<Record<string, unknown>> {
        return this.request("PATCH", `/${type}/${id}`, undefined, payload, ifMatchHeader(opts?.ifMatch));
    }

    /** DELETE, with `If-Match` as update sends it when the note's change_seq is known. */
    async deleteElement(type: string, id: string, opts?: { ifMatch?: number | null }): Promise<void> {
        await this.request("DELETE", `/${type}/${id}`, undefined, undefined, ifMatchHeader(opts?.ifMatch));
    }

    /**
     * GET /me: who this key is in its world (`kind`, `role`, `membership`,
     * `character` as an id or null). A read: an `ow_` key needs no PIN.
     */
    async me(): Promise<Record<string, unknown>> {
        return this.request("GET", "/me");
    }

    /**
     * Atomic multi-create: POST /bulk with `{ items: [{ type, element }] }`
     * (wire-verified 2026-07-13 — flat element bodies 422 with
     * "item.element must be an object"). Server resolves FK order (including
     * cycles) — the right tool for first pushes of locally-built worlds with
     * cross-links. Client-supplied ids are preserved. `atomic: true`: if any
     * item fails, nothing is written, and the response still lists each item
     * as it would have gone (`errors: true` says nothing landed).
     * `createOnly: true` (the server has taken it since 2026-11-21): an item whose id is
     * already held answers 409 `id_conflict` in its own slot and the held
     * element is NOT replaced; without it /bulk replaces the held element whole.
     * Both callers create by intent, so both send it. The server refuses a key
     * it does not know with a 422, so the word goes only when asked for.
     */
    async bulkCreate(
        items: { type: string; element: Record<string, unknown> }[],
        opts?: { atomic?: boolean; createOnly?: boolean }
    ): Promise<Record<string, unknown>> {
        const body: Record<string, unknown> = { items };
        if (opts?.atomic) body.atomic = true;
        if (opts?.createOnly) body.create_only = true;
        return this.request("POST", "/bulk", undefined, body);
    }

    /** One page of the world's change feed. Pass the previous page's cursor as `since`. */
    async changesPage(since?: string, limit = 100): Promise<V2ChangesPage> {
        return this.request("GET", "/changes", { since, limit });
    }

    /**
     * Walk the full change feed from `since` (or the epoch when omitted).
     * Termination is `has_more === false` — the final page still carries a
     * cursor, which is exactly what callers persist for the next incremental
     * pull. Later changes win per element id — apply in order.
     */
    async changesWalk(since?: string): Promise<{ changes: V2Change[]; cursor: string | null; head: number }> {
        const all: V2Change[] = [];
        let cursor = since;
        let head = 0;
        // Hard page cap as a runaway guard: 1000 pages * 100 = 100k changes,
        // far beyond any real vault world.
        for (let page = 0; page < 1000; page++) {
            const result = await this.changesPage(cursor, 100);
            all.push(...result.changes);
            head = result.head;
            cursor = result.cursor ?? cursor;
            if (!result.has_more) break;
        }
        return { changes: all, cursor: cursor ?? null, head };
    }
}
