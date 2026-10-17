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
 * With no stored cursor this device never downloaded the world, and cannot
 * tell a never-uploaded note from a deleted one: `known` is false, and the
 * caller says so.
 */

/** The plugin data this reads and keeps. */
export interface DeletedListHost {
	settings: {
		deletedOnServer?: Record<string, string[]>;
		syncCursors?: Record<string, { cursor?: string } | undefined>;
	};
	saveSettings?: () => Promise<void>;
}

/** The client calls this needs. */
export interface DeletedListClient {
	getWorld(): Promise<Record<string, unknown>>;
	changesWalk(since?: string): Promise<{ changes: { id: string; op: string }[] }>;
}

export interface DeletedView {
	/** The world's id, "" when it could not be read. */
	worldId: string;
	/** Element ids deleted on the server. */
	ids: Set<string>;
	/** False when this device cannot tell (no stored cursor, or the feed could not be read). */
	known: boolean;
}

/** The deleted ids of the world `client`'s key names, the feed read once from the stored cursor. */
export async function readDeletedOnServer(host: DeletedListHost, client: DeletedListClient): Promise<DeletedView> {
	let worldId: string;
	try {
		worldId = String((await client.getWorld()).id ?? "");
	} catch {
		return { worldId: "", ids: new Set(), known: false };
	}
	const ids = new Set(host.settings.deletedOnServer?.[worldId] ?? []);
	const cursor = host.settings.syncCursors?.[worldId]?.cursor;
	if (!worldId || !cursor) return { worldId, ids, known: false };
	let changes: { id: string; op: string }[];
	try {
		changes = (await client.changesWalk(cursor)).changes;
	} catch {
		return { worldId, ids, known: false };
	}
	const latest = new Map<string, string>();
	for (const c of changes) latest.set(c.id, c.op);
	for (const [id, op] of latest) {
		if (op === "delete") ids.add(id);
		else ids.delete(id);
	}
	host.settings.deletedOnServer = { ...(host.settings.deletedOnServer ?? {}), [worldId]: [...ids] };
	try {
		await host.saveSettings?.();
	} catch {
		/* the list is still right for this run */
	}
	return { worldId, ids, known: true };
}

/** Take ids out of the list once they exist on the server again (created again by the user's choice). */
export async function forgetDeleted(host: DeletedListHost, worldId: string, created: string[]): Promise<void> {
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
