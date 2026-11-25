import { App, normalizePath } from "obsidian";

/**
 * The change_seq index: `.ow-seq.json` inside a world folder.
 * Per element id, the `change_seq` its note was last pulled or saved
 * at. A save sends it as `If-Match`, so keel refuses (412) a save from a note
 * pulled before another writer's change instead of reverting that change.
 *
 *   - Written by Download (each note it writes, at the feed row's change_seq)
 *     and by every save that lands (the answer's change_seq): Save element,
 *     auto-sync, Upload world. A create whose answer carries no change_seq
 *     (Upload's /bulk) clears the id's entry, so the next save is unguarded
 *     once and records the number then.
 *   - Read by those saves and by Delete element.
 *   - Never a note field: keel 422s a server field in a write body, and a note
 *     is what a save sends. Never in an export (the folder export writes from
 *     the notes and the folder sidecar, not this file).
 *
 * Adapter I/O only, as the folder sidecar (folder-sidecar.ts): Obsidian's vault
 * index skips dot-prefixed files, so a write here fires no vault event and no
 * auto-sync. Writes to one world's index are queued one after another, so two
 * saves landing together never write back an older number over a newer one
 * (a lost newer number would refuse the next save as stale).
 */
export type ChangeSeqIndex = Record<string, number>;

function indexPath(world: string): string {
	return normalizePath(`OnlyWorlds/Worlds/${world}/.ow-seq.json`);
}

/** A whole, non-negative change_seq, or null. */
export function asChangeSeq(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The change_seq a v2 element body carries, or null. */
export function changeSeqOf(body: unknown): number | null {
	return body && typeof body === "object" ? asChangeSeq((body as { change_seq?: unknown }).change_seq) : null;
}

/**
 * A mark entry beside an id's number (`<id>^`, the number the note showed the world's group at): the note holds the world's group, so deleting every entry of it from the note is the
 * person's deletion and a save clears the group. Set by a Download of an element that has a group, and by a save or an upload that sends
 * or finds one equal; taken away by a save that sends none, a bulk create and a delete. A note with a number and no mark (made before
 * the mark existed, or never shown the group) is never cleared. An older plugin reads the mark as one more number under an id nobody asks for, and renews the id's number without the mark: a mark that no longer equals the number clears nothing.
 */
export function heldKey(id: string): string {
	return `${id}^`;
}

/** The world's index, or an empty one when absent or unreadable. */
export async function readChangeSeqIndex(app: App, world: string): Promise<ChangeSeqIndex> {
	const path = indexPath(world);
	try {
		if (!(await app.vault.adapter.exists(path))) return {};
		const parsed: unknown = JSON.parse(await app.vault.adapter.read(path));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: ChangeSeqIndex = {};
		for (const [id, seq] of Object.entries(parsed as Record<string, unknown>)) {
			const n = asChangeSeq(seq);
			if (n !== null) out[id] = n;
		}
		return out;
	} catch {
		return {};
	}
}

/** The change_seq the note of `id` was last pulled or saved at, or null when none is recorded. */
export async function readChangeSeq(app: App, world: string, id: string): Promise<number | null> {
	return (await readChangeSeqIndex(app, world))[id] ?? null;
}

const queues = new WeakMap<App, Map<string, Promise<void>>>();

/**
 * Record change_seqs for `world`: a number sets the id's entry, null clears
 * it. Queued per world (see above). Never throws: a failed write is logged,
 * and the next save of that note goes out unguarded once or is refused as
 * stale (never a silent revert).
 */
export function recordChangeSeqs(app: App, world: string, entries: Record<string, number | null>): Promise<void> {
	if (Object.keys(entries).length === 0) return Promise.resolve();
	let byWorld = queues.get(app);
	if (!byWorld) {
		byWorld = new Map();
		queues.set(app, byWorld);
	}
	const prev = byWorld.get(world) ?? Promise.resolve();
	const next = prev.then(async () => {
		try {
			const index = await readChangeSeqIndex(app, world);
			for (const [id, seq] of Object.entries(entries)) {
				if (seq === null) delete index[id];
				else index[id] = seq;
			}
			await app.vault.adapter.write(indexPath(world), JSON.stringify(index, null, 1) + "\n");
		} catch (error) {
			console.error(`OnlyWorlds: could not record change_seq for ${world}`, error);
		}
	});
	byWorld.set(world, next);
	return next;
}
