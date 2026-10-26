/**
 * Which elements of a world were deleted on onlyworlds.com, as far as this
 * device can know (Kael's reads, blocker 1c and N3).
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
		/** Per world id: element ids hidden from this reader by the world's owner (sync/hidden-on-server.ts). */
		hiddenOnServer?: Record<string, string[]>;
		/** Per world id: ids a role (or no-reason) reset's walk no longer named (Kael's read, 2026-10-20). */
		leftView?: Record<string, string[]>;
		syncCursors?: Record<string, { cursor?: string; head?: number } | undefined>;
	};
	saveSettings?: () => Promise<void>;
}

/** A change of the feed as this reads it: a delete row carries `reason` while keel's hidden mark is on. */
export interface FeedChange {
	id: string;
	op: string;
	reason?: string | null;
}

/** The client calls this needs. */
export interface DeletedListClient {
	getWorld(): Promise<Record<string, unknown>>;
	changesWalk(since?: string): Promise<{ changes: FeedChange[]; cursor?: string | null; head?: number }>;
}

/**
 * Why this device cannot tell: it never downloaded the world here, the feed
 * read failed, or the server is behind the stored cursor (restored from a
 * backup since the last Download; Kael's third read, 4).
 */
export type CannotTell = "failed" | "rewound" | "resync";

export interface DeletedView {
	/** The world's id, "" when it could not be read. */
	worldId: string;
	/**
	 * Element ids gone from the server for this reader: deleted, or hidden by
	 * the world's owner (a GET answers 404 for both). Every caller that leaves
	 * a deleted id out leaves a hidden one out too.
	 */
	ids: Set<string>;
	/** The ids of `ids` that are hidden, not deleted: named so, never offered to create again. */
	hidden: Set<string>;
	/** The ids of `ids` no longer in this reader's view after a role (or no-reason) reset: kept notes, never created again. */
	leftView: Set<string>;
	/** False when this device cannot tell (no stored cursor, or the feed could not be read). */
	known: boolean;
	/** Why not, when `known` is false: no stored cursor (never downloaded here), or a read that failed. */
	reason?: CannotTell;
}

/**
 * Per plugin (the host) and world id, for the session, in memory only, gone
 * with the plugin object: the cursor the last walk ended at, the stored
 * (Download's) cursor that walk saw, and (for a device with no stored cursor)
 * the deletes the session has seen (amended rule 2; Kael's delta read, 1;
 * the fix round, item 4).
 */
const sessionState = new WeakMap<object, Map<string, { cursor?: string; stored?: string; head?: number; seen: Set<string>; seenHidden: Set<string> }>>();

/**
 * `ids` and `hidden` with each change's latest op applied: a delete adds its
 * id to `ids`, and to `hidden` when its reason is `hidden` (out of it
 * otherwise); any other op (an upsert, an unhide) takes it out of both.
 */
function foldDeletes(ids: Set<string>, hidden: Set<string>, leftView: Set<string>, changes: FeedChange[]): void {
	const latest = new Map<string, FeedChange>();
	for (const c of changes) latest.set(c.id, c);
	for (const [id, c] of latest) {
		// An id the feed names again is in view again: any row takes it off.
		leftView.delete(id);
		if (c.op === "delete") ids.add(id);
		else ids.delete(id);
		if (c.op === "delete" && c.reason === "hidden") hidden.add(id);
		else hidden.delete(id);
	}
}

/** The world's stored deleted, hidden and left-view lists, as one view's `ids`, `hidden` and `leftView`. */
function storedView(host: DeletedListHost, worldId: string): { ids: Set<string>; hidden: Set<string>; leftView: Set<string> } {
	const hidden = new Set(host.settings.hiddenOnServer?.[worldId] ?? []);
	const leftView = new Set(host.settings.leftView?.[worldId] ?? []);
	return { ids: new Set([...(host.settings.deletedOnServer?.[worldId] ?? []), ...hidden, ...leftView]), hidden, leftView };
}

/**
 * Per plugin (the host) and world id: the feed read in flight, so saves that
 * reach a 404 together share one walk (round C, 7; Kael's delta read, low 4:
 * two first saves on a device with no cursor each walked the whole feed).
 */
const inFlight = new WeakMap<object, Map<string, Promise<DeletedView>>>();

/** The deleted ids of the world `client`'s key names, the feed read once from the stored cursor. */
export async function readDeletedOnServer(host: DeletedListHost, client: DeletedListClient): Promise<DeletedView> {
	let worldId: string;
	try {
		worldId = String((await client.getWorld()).id ?? "");
	} catch {
		return { worldId: "", ids: new Set(), hidden: new Set(), leftView: new Set(), known: false, reason: "failed" };
	}
	if (!worldId) return { worldId, ...storedView(host, worldId), known: false, reason: "failed" };
	let pending = inFlight.get(host);
	if (!pending) inFlight.set(host, (pending = new Map()));
	const running = pending.get(worldId);
	if (running) {
		const view = await running;
		return { ...view, ids: new Set(view.ids), hidden: new Set(view.hidden), leftView: new Set(view.leftView) };
	}
	const read = readFeed(host, client, worldId);
	pending.set(worldId, read);
	try {
		const view = await read;
		return { ...view, ids: new Set(view.ids), hidden: new Set(view.hidden), leftView: new Set(view.leftView) };
	} finally {
		pending.delete(worldId);
	}
}

/** One feed read for `worldId`, folded into the view (readDeletedOnServer shares it). */
async function readFeed(host: DeletedListHost, client: DeletedListClient, worldId: string): Promise<DeletedView> {
	const { ids, hidden, leftView } = storedView(host, worldId);
	const stored = host.settings.syncCursors?.[worldId];
	const cursor = stored?.cursor;
	// The session reads on from where its last walk ended, in memory only:
	// the first walk starts at Download's cursor, or at the start of the feed
	// when this device has none (a kept note can sit here anyway: notes
	// outlive data.json through a reinstall or a vault synced by git,
	// Syncthing or iCloud). So a delete made on the web mid-session is caught
	// at the next 404, and each read is one short page (Kael's delta read, 1).
	let sessions = sessionState.get(host);
	if (!sessions) sessionState.set(host, (sessions = new Map()));
	const session = sessions.get(worldId);
	// A stored cursor other than the one the session last saw means a
	// Download ran since: the session starts from it, whether it is past the
	// session's (round C, 9) or behind it, after a server restore (the fix
	// round, item 4; Kael's c-read, low 4: the heads ordered the two and kept
	// the session on its pre-restore cursor). Cursors are keel's own, so they
	// are compared for equality only.
	const downloadRan = !session?.cursor || session.stored !== cursor;
	let since = downloadRan ? cursor ?? session?.cursor : session.cursor;
	let rewound = false;
	let walk: { changes: FeedChange[]; cursor?: string | null; head?: number };
	for (;;) {
		try {
			walk = await client.changesWalk(since);
		} catch (error) {
			// keel's 409 resync_required (a guest's cursor after a delete it could
			// see) holds until a Download re-walks: say that, not "try again"
			// (Kael's delta read, low 3).
			const e = error as { status?: unknown; code?: unknown } | null;
			const resync = e?.status === 409 && e?.code === "resync_required";
			return { worldId, ids, hidden, leftView, known: false, reason: resync ? "resync" : "failed" };
		}
		// A head below the one the session's last walk ended at: the server
		// was restored since, and the session's cursor points past what it
		// holds. A restore to the last Download's exact point stores a
		// byte-identical cursor (keel's is seq:id), so the stored cursor alone
		// cannot tell (Kael's fixes read, low 3). Read once more from the
		// stored cursor (or the start), the session's view dropped.
		if (!rewound && since !== cursor && typeof session?.head === "number" && typeof walk.head === "number" && walk.head < session.head) {
			rewound = true;
			since = cursor;
			continue;
		}
		break;
	}
	// A head below the one Download stored: the server was restored, and a
	// delete at or below the old cursor would never show (Download compares
	// heads the same way).
	if (cursor && typeof stored?.head === "number" && typeof walk.head === "number" && walk.head < stored.head) {
		return { worldId, ids, hidden, leftView, known: false, reason: "rewound" };
	}
	const seen = (!rewound && session?.seen) || new Set<string>();
	const seenHidden = (!rewound && session?.seenHidden) || new Set<string>();
	sessions.set(worldId, { cursor: walk.cursor ?? since, stored: cursor, head: walk.head, seen, seenHidden });
	if (!cursor) {
		// No stored cursor: the view stays in memory, never written as a
		// cursor or into the list (amended rule 2).
		foldDeletes(seen, seenHidden, leftView, walk.changes);
		for (const id of seen) ids.add(id);
		for (const id of seenHidden) hidden.add(id);
		return { worldId, ids, hidden, leftView, known: true };
	}
	foldDeletes(ids, hidden, leftView, walk.changes);
	// The two lists stay apart: a hidden id is never on the deleted list (no
	// delete review offers it back), and Download stubs its note.
	host.settings.deletedOnServer = { ...(host.settings.deletedOnServer ?? {}), [worldId]: [...ids].filter((id) => !hidden.has(id) && !leftView.has(id)) };
	host.settings.hiddenOnServer = { ...(host.settings.hiddenOnServer ?? {}), [worldId]: [...hidden] };
	host.settings.leftView = { ...(host.settings.leftView ?? {}), [worldId]: [...leftView] };
	try {
		await host.saveSettings?.();
	} catch {
		/* the list is still right for this run */
	}
	return { worldId, ids, hidden, leftView, known: true };
}

/**
 * The stored lists alone, no feed read: what auto-sync consults, so a save it
 * makes at every pause costs one `getWorld` and nothing more (Kael's third
 * read, 4). `ids` holds the deleted and the hidden ids, `hidden` the hidden
 * ones. Empty when the world's id cannot be read.
 */
export async function storedDeleted(
	host: DeletedListHost,
	client: { getWorld(): Promise<Record<string, unknown>> }
): Promise<{ ids: Set<string>; hidden: Set<string>; leftView: Set<string> }> {
	try {
		return storedView(host, String((await client.getWorld()).id ?? ""));
	} catch {
		return { ids: new Set(), hidden: new Set(), leftView: new Set() };
	}
}

/**
 * Take ids out of the list once they exist on the server again (created again
 * by the user's choice). With no world id (the world could not be read after
 * a 410's recreate), every world's list is swept: an element id belongs to one
 * world, so the id is taken off wherever it sits (Kael's delta read, 10-18).
 */
export async function forgetDeleted(host: DeletedListHost, worldId: string, created: string[]): Promise<void> {
	if (created.length === 0) return;
	const gone = new Set(created);
	const worlds = worldId ? [worldId] : Object.keys(host.settings.deletedOnServer ?? {});
	const sessions = worldId ? [sessionState.get(host)?.get(worldId)] : [...(sessionState.get(host)?.values() ?? [])];
	for (const s of sessions) for (const id of created) s?.seen?.delete(id);
	let changed = false;
	const next = { ...(host.settings.deletedOnServer ?? {}) };
	for (const w of worlds) {
		const list = next[w];
		if (!list || !list.some((id) => gone.has(id))) continue;
		next[w] = list.filter((id) => !gone.has(id));
		changed = true;
	}
	if (!changed) return;
	host.settings.deletedOnServer = next;
	try {
		await host.saveSettings?.();
	} catch {
		/* best effort */
	}
}

/**
 * How many of a walk's deletes left a note of their own in this vault
 * (Seethe on 3.5.1: a fresh vault's first download walks the world's whole
 * history and said "7 elements deleted on the server — their notes were kept"
 * with no note in the vault). Counted against the notes' OWN ids, never the ids
 * their Properties link to: a stale raw-id link is not a kept note (Kael's read,
 * 2026-10-19). `latest` is the walk folded to one change per id, later ops winning.
 */
export function keptDeleteCount(latest: Iterable<FeedChange>, ownNoteIds: Set<string>): number {
	let n = 0;
	for (const change of latest) {
		// A hidden row is counted apart, never as a delete.
		if (change.op === "delete" && change.reason !== "hidden" && ownNoteIds.has(change.id)) n++;
	}
	return n;
}
