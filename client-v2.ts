import { requestUrl, RequestUrlParam } from "obsidian";

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

/**
 * v1-parse output → v2 wire payload. The span-tag parsers emit link keys with
 * the v1 write suffixes (`location_id`, `abilities_ids`); v2 speaks bare
 * schema names and loud-422s unknown fields. `world`/`world_id` are stripped
 * (world identity is the API key).
 */
export function toV2Payload(element: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(element)) {
        if (key === "world" || key === "world_id") continue;
        if (key.endsWith("_ids")) {
            out[key.slice(0, -4)] = value;
        } else if (key.endsWith("_id")) {
            out[key.slice(0, -3)] = value;
        } else {
            out[key] = value;
        }
    }
    return out;
}

export interface V2Change {
    op: "upsert" | "delete";
    type: string;
    id: string;
    change_seq: number;
    updated_at: string;
    element?: Record<string, unknown>;
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

    constructor(status: number, code: string, message: string, docUrl: string | null) {
        super(message);
        this.name = "V2ApiError";
        this.status = status;
        this.code = code;
        this.docUrl = docUrl;
    }
}

export class V2Client {
    private headers: Record<string, string>;

    constructor(apiKey: string, apiPin: string) {
        this.headers = {
            "Content-Type": "application/json",
            "API-Key": apiKey,
            "API-Pin": apiPin,
        };
    }

    private async request<T>(
        method: string,
        path: string,
        params?: Record<string, string | number | undefined>,
        body?: unknown
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
            headers: this.headers,
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
            try {
                const parsed = JSON.parse(response.text);
                if (parsed && typeof parsed === "object" && parsed.error) {
                    code = parsed.error.code ?? code;
                    message = parsed.error.message ?? message;
                    docUrl = parsed.error.doc_url ?? null;
                } else if (response.text) {
                    message += `: ${response.text}`;
                }
            } catch {
                if (response.text) message += `: ${response.text}`;
            }
            throw new V2ApiError(response.status, code, message, docUrl);
        }

        if (response.status === 204) {
            return undefined as unknown as T;
        }
        return response.json as T;
    }

    async getWorld(): Promise<Record<string, unknown>> {
        return this.request("GET", "/world");
    }

    async get(type: string, id: string): Promise<Record<string, unknown>> {
        return this.request("GET", `/${type}/${id}`);
    }

    async create(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.request("POST", `/${type}`, undefined, payload);
    }

    /** PATCH — send only the fields you parsed; the server merges. */
    async update(type: string, id: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.request("PATCH", `/${type}/${id}`, undefined, payload);
    }

    async deleteElement(type: string, id: string): Promise<void> {
        await this.request("DELETE", `/${type}/${id}`);
    }

    /**
     * Atomic multi-create: POST /bulk with `{ items: [{ type, element }] }`
     * (wire-verified 2026-07-13 — flat element bodies 422 with
     * "item.element must be an object"). Server resolves FK order (including
     * cycles) — the right tool for first pushes of locally-built worlds with
     * cross-links. Client-supplied ids are preserved.
     */
    async bulkCreate(items: { type: string; element: Record<string, unknown> }[]): Promise<Record<string, unknown>> {
        return this.request("POST", "/bulk", undefined, { items });
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
