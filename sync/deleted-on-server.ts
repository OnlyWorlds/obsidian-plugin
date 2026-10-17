/**
 * Which elements of a world were deleted on onlyworlds.com, as far as this
 * device can know (OW Infra #166 row 8; Kael's reads, blocker 1c and N3).
 *
 * A GET answers 404 for a deleted element exactly as for one never uploaded,
 * so a 404 alone must never be read as "create it". Download keeps the ids its
 * change feed reported deleted in the plugin's data (settings.deletedOnServer,
 * by world id). That list is only as fresh as the last Download, so this reads
 * the feed once more from the stored cursor and folds in what it reports. The
 * cursor itself is Download's and is never moved here: the notes have not
 * taken those changes.
 *
 * With no stored cursor the feed is read from the start once, and that view is
 * kept for the session in memory (a kept note outlives data.json). When a read
 * fails, or the server is behind the stored head, `known` is false and the
 * caller says why.
 */

/** The plugin data this reads and keeps. */
export interface DeletedListHost {
	settings: {
		deletedOnServer?: Record<string, string[]>;
		syncCursors?: Record<string, { cursor?: string; head?: number } | undefined>;
	};
	saveSettings?: () => Promise<void>;
}

/** The client calls this needs. */
export interface DeletedListClient {
	getWorld(): Promise<Record<string, unknown>>;
	changesWalk(since?: string): Promise<{ changes: { id: string; op: string }[]; cursor?: string | null; head?: number }>;
}

/**
 * Why this device cannot tell: it never downloaded the world here, the feed
 * read failed, or the server is behind the stored cursor (restored from a
 * backup since the last Download; Kael's third read, 4).
 */
export type CannotTell = "no-cursor" | "failed" | "rewound";

export interface DeletedView {
	/** The world's id, "" when it could not be read. */
	worldId: string;
	/** Element ids deleted on the server. */
	ids: Set<string>;
	/** False when this device cannot tell (no stored cursor, or the feed could not be read). */
	known: boolean;
	/** Why not, when `known` is false: no stored cursor (never downloaded here), or a read that failed. */
	reason?: CannotTell;
}

/**
 * Per plugin (the host) and world id, for the session, in memory only, gone
 * with the plugin object: the cursor the last walk ended at, and (for a device
 * with no stored cursor) the deletes the session has seen (amended rule 2;
 * Kael's delta read, 1).
 */
const sessionState = new WeakMap<object, Map<string, { cursor?: string; seen: Set<string> }>>();

/** `ids` with each change's latest op applied: a delete adds its id, any other op takes it out. */
function foldDeletes(ids: Set<string>, changes: { id: string; op: string }[]): Set<string> {
	const latest = new Map<string, string>();
	for (const c of changes) latest.set(c.id, c.op);
	for (const [id, op] of latest) {
		if (op === "delete") ids.add(id);
		else ids.delete(id);
	}
	return ids;
}

/** The deleted ids of the world `client`'s key names, the feed read once from the stored cursor. */
export async function readDeletedOnServer(host: DeletedListHost, client: DeletedListClient): Promise<DeletedView> {
	let worldId: string;
	try {
		worldId = String((await client.getWorld()).id ?? "");
	} catch {
		return { worldId: "", ids: new Set(), known: false, reason: "failed" };
	}
	const ids = new Set(host.settings.deletedOnServer?.[worldId] ?? []);
	const stored = host.settings.syncCursors?.[worldId];
	const cursor = stored?.cursor;
	if (!worldId) return { worldId, ids, known: false, reason: "failed" };
	// The session reads on from where its last walk ended, in memory only:
	// the first walk starts at Download's cursor, or at the start of the feed
	// when this device has none (a kept note can sit here anyway: notes
	// outlive data.json through a reinstall or a vault synced by git,
	// Syncthing or iCloud). So a delete made on the web mid-session is caught
	// at the next 404, and each read is one short page (Kael's delta read, 1).
	let sessions = sessionState.get(host);
	if (!sessions) sessionState.set(host, (sessions = new Map()));
	const session = sessions.get(worldId);
	const since = session?.cursor ?? cursor;
	let walk: { changes: { id: string; op: string }[]; cursor?: string | null; head?: number };
	try {
		walk = await client.changesWalk(since);
	} catch {
		return { worldId, ids, known: false, reason: "failed" };
	}
	// A head below the one Download stored: the server was restored, and a
	// delete at or below the old cursor would never show (Download compares
	// heads the same way).
	if (cursor && typeof stored?.head === "number" && typeof walk.head === "number" && walk.head < stored.head) {
		return { worldId, ids, known: false, reason: "rewound" };
	}
	const seen = session?.seen ?? new Set<string>();
	sessions.set(worldId, { cursor: walk.cursor ?? since, seen });
	if (!cursor) {
		// No stored cursor: the view stays in memory, never written as a
		// cursor or into the list (amended rule 2).
		foldDeletes(seen, walk.changes);
		for (const id of seen) ids.add(id);
		return { worldId, ids, known: true };
	}
	foldDeletes(ids, walk.changes);
	host.settings.deletedOnServer = { ...(host.settings.deletedOnServer ?? {}), [worldId]: [...ids] };
	try {
		await host.saveSettings?.();
	} catch {
		/* the list is still right for this run */
	}
	return { worldId, ids, known: true };
}

/**
 * The stored list alone, no feed read: what auto-sync consults, so a save it
 * makes at every pause costs one `getWorld` and nothing more (Kael's third
 * read, 4). Empty when the world's id cannot be read.
 */
export async function storedDeleted(host: DeletedListHost, client: { getWorld(): Promise<Record<string, unknown>> }): Promise<Set<string>> {
	try {
		const worldId = String((await client.getWorld()).id ?? "");
		return new Set(host.settings.deletedOnServer?.[worldId] ?? []);
	} catch {
		return new Set();
	}
}

/** Take ids out of the list once they exist on the server again (created again by the user's choice). */
export async function forgetDeleted(host: DeletedListHost, worldId: string, created: string[]): Promise<void> {
	const seen = sessionState.get(host)?.get(worldId)?.seen;
	for (const id of created) seen?.delete(id);
	const list = host.settings.deletedOnServer?.[worldId];
	if (!list || created.length === 0) return;
	const gone = new Set(created);
	host.settings.deletedOnServer = { ...host.settings.deletedOnServer, [worldId]: list.filter((id) => !gone.has(id)) };
	try {
		await host.saveSettings?.();
	} catch {
		/* best effort */
	}
}
