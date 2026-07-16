import { App, normalizePath } from "obsidian";

/**
 * Persistent per-vault world identity: `.ow-world-id` inside the world folder.
 *
 * Why it exists: World.md carries no world UUID, but the folder bridge needs a
 * STABLE identity — a fresh id per export would make every re-export a brand-new
 * world in Atlas, and re-importing a re-export would trip the never-merge guard
 * against the previous import of the very same world (gate finding, 2026-07-16).
 * Export reads-or-mints-and-persists through this marker; import records the
 * imported folder's id here so the mismatch guard has something to compare.
 *
 * Adapter I/O ONLY, never the vault API: Obsidian's vault index excludes
 * dot-prefixed files — getAbstractFileByPath returns null forever and
 * vault.create refuses the path. Unindexed files also emit no vault events, so
 * no auto-sync self-write mark is needed.
 */

function markerPath(world: string): string {
	return normalizePath(`OnlyWorlds/Worlds/${world}/.ow-world-id`);
}

/** Read the persisted world id (null if none recorded yet). */
export async function readWorldIdMarker(app: App, world: string): Promise<string | null> {
	const path = markerPath(world);
	try {
		if (!(await app.vault.adapter.exists(path))) return null;
		const m = /world_id:\s*([0-9a-fA-F-]{36})/.exec(await app.vault.adapter.read(path));
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

/** Persist the world id (first-writer wins; existing marker is never rewritten). */
export async function writeWorldIdMarker(app: App, world: string, worldId: string): Promise<void> {
	const folder = normalizePath(`OnlyWorlds/Worlds/${world}`);
	if (!app.vault.getAbstractFileByPath(folder)) return; // world folder must exist
	const path = markerPath(world);
	if (await app.vault.adapter.exists(path)) return;
	await app.vault.adapter.write(
		path,
		`world_id: ${worldId}\nOnlyWorlds folder identity marker (do not edit).\n`
	);
}
