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
	changesWalk(since?: string): Promise<{ changes: { id: string; op: string }[]; head?: number }>;
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
 * The no-cursor full reads, per plugin (the host) and world id, for the
 * session: memory only, gone with the plugin object (amended rule 2).
 */
const sessionViews = new WeakMap<object, Map<string, Set<string>>>();

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
	if (!cursor) {
		// No stored cursor, yet a kept note can still sit here (notes outlive
		// data.json: a reinstall, a vault synced by git, Syncthing or iCloud).
		// Read the feed from the start once, and keep that view for the
		// session, in memory: never written as a cursor or into the list
		// (amended rule 2, Kael's correction).
		let views = sessionViews.get(host);
		if (!views) sessionViews.set(host, (views = new Map()));
		let seen = views.get(worldId);
		if (!seen) {
			try {
				seen = foldDeletes(new Set(), (await client.changesWalk()).changes);
			} catch {
				return { worldId, ids, known: false, reason: "failed" };
			}
			views.set(worldId, seen);
		}
		for (const id of seen) ids.add(id);
		return { worldId, ids, known: true };
	}
	let changes: { id: string; op: string }[];
	try {
		const walk = await client.changesWalk(cursor);
		// A head below the one Download stored: the server was restored, and a
		// delete at or below the old cursor would never show (Download compares
		// heads the same way).
		if (typeof stored?.head === "number" && typeof walk.head === "number" && walk.head < stored.head) {
			return { worldId, ids, known: false, reason: "rewound" };
		}
		changes = walk.changes;
	} catch {
		return { worldId, ids, known: false, reason: "failed" };
	}
	foldDeletes(ids, changes);
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
	const seen = sessionViews.get(host)?.get(worldId);
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
